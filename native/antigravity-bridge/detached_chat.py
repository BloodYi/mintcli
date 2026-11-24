"""Own web turns independently of an HTTP reader; persist their existing UI data."""
from __future__ import annotations

import asyncio
from collections import deque
import copy
import json
from pathlib import Path
import re
import time
import uuid


def _extract(raw, streaming=False):
    """Match the browser's think-tag rules, including literal Markdown examples."""
    content, thought, thoughts = [], [], []
    depth, ticks, fence, tagged, index = 0, 0, None, False, 0
    def append(value):
        (thought if depth else content).append(value)
    def flush():
        value = ''.join(thought).strip()
        if value and value != '...':
            thoughts.append(value)
        thought.clear()
    while index < len(raw):
        tail = raw[index:]
        if not ticks and (index == 0 or raw[index - 1] == '\n'):
            quote = re.match(r'^(?: {0,3}>[ \t]?)+', tail)
            quote_depth = quote[0].count('>') if quote else 0
            if fence and fence[2] > quote_depth:
                fence = None
            marker = re.match(r'^(?: {0,3}>[ \t]?)* {0,3}(`{3,}|~{3,})([^\n]*)(?:\n|$)', tail)
            if marker:
                if not fence:
                    fence = (marker[1][0], len(marker[1]), quote_depth)
                elif marker[1][0] == fence[0] and len(marker[1]) >= fence[1] and not marker[2].strip():
                    fence = None
                append(marker[0]); index += len(marker[0]); continue
            indented = re.match(r'^(?: {4}|\t)[^\n]*(?:\n|$)', tail) if not fence else None
            if indented:
                append(indented[0]); index += len(indented[0]); continue
        if fence:
            append(raw[index]); index += 1; continue
        if not ticks and raw[index] == '\\' and index + 1 < len(raw):
            append(raw[index:index + 2]); index += 2; continue
        if raw[index] == '`':
            marker = re.match(r'^`+', tail)[0]
            append(marker)
            if not ticks and (streaming or any(len(value) == len(marker) for value in re.findall(r'`+', tail[len(marker):]))):
                ticks = len(marker)
            elif ticks == len(marker):
                ticks = 0
            index += len(marker); continue
        if not ticks and raw[index] == '<':
            tag = re.match(r'^</?think>', tail, re.I)
            if tag and (not tag[0].startswith('</') or depth):
                tagged = True
                if tag[0].startswith('</'):
                    depth -= 1
                    if not depth:
                        flush()
                else:
                    depth += 1
                index += len(tag[0]); continue
            if streaming and any(value.startswith(tail.lower()) for value in ('<think>', '</think>')):
                break
        append(raw[index]); index += 1
    if depth:
        flush()
    value = ''.join(content)
    return {'content': value.lstrip('\n') if tagged else value, 'thinking': '\n\n'.join(thoughts)}


class WebTurn:
    def __init__(self, manager, turn_id, stream, conversation_id, messages, model, model_label):
        self.manager, self.id, self.stream, self.cid = manager, turn_id, stream, conversation_id
        self._model, self._model_label = model, model_label
        self.messages = copy.deepcopy(messages)
        if self.messages:
            self.messages[-1]['turnId'] = turn_id
            self.messages[-1].setdefault('id', uuid.uuid4().hex)
            self.messages[-1].setdefault('created_at', time.time())
        self.assistant = self._new_assistant()
        self._turn_assistants = [self.assistant]
        self._pending_segments: dict[str, dict] = {}
        self._inject_handler = None
        self._inject_lock = asyncio.Lock()
        self._step_seq = 0
        self._step_raw: dict[str, str] = {}
        self.messages.append(self.assistant)
        self.status, self.sequence, self.history = 'running', 0, deque(maxlen=256)
        self.changed, self.saved_at, self.task, self.updated_at = asyncio.Event(), 0, None, time.time()
        self.stop_requested = False

    def _new_assistant(self, created_at: float | None = None):
        return {
            'role': 'assistant', 'content': '', 'thinking': '', 'thoughtOpen': True,
            'id': uuid.uuid4().hex, 'created_at': created_at if created_at is not None else time.time(),
            'model': self._model_label, 'requestedModel': self._model or 'default',
            'turnId': self.id, 'status': 'streaming', 'rawText': '', 'finalResponse': '',
            'eventThinking': '', 'thinkingOrder': [], 'errorText': '', 'steps': [],
        }

    def set_injector(self, handler):
        self._inject_handler = handler

    async def inject(self, content: str, *, formatted_prompt: str, attachments=None, message_id: str | None = None):
        async with self._inject_lock:
            if self.status != 'running' or self.stop_requested or self._inject_handler is None:
                return None
            msg_id = message_id or uuid.uuid4().hex
            accepted = await self._inject_handler(formatted_prompt, msg_id)
            if not accepted:
                return None
            now_ts = time.time()
            user_msg = {
                'id': msg_id,
                'role': 'user',
                'content': content,
                'created_at': now_ts,
                'timestamp': self._iso_now(),
                'turnId': self.id,
            }
            if attachments:
                user_msg['attachments'] = copy.deepcopy(attachments)
            next_assistant = self._new_assistant(created_at=now_ts + 0.001)
            self.messages.append(user_msg)
            self.messages.append(next_assistant)
            self._turn_assistants.append(next_assistant)
            self._pending_segments[msg_id] = next_assistant
            self.save(True)
            return {
                'id': self.id,
                'conversation_id': self.cid,
                'status': self.status,
                'message_id': msg_id,
                'assistant_id': next_assistant['id'],
            }

    @staticmethod
    def _is_empty_assistant(message: dict) -> bool:
        if str(message.get('content') or '').strip():
            return False
        if str(message.get('thinking') or '').strip():
            return False
        if str(message.get('errorText') or '').strip():
            return False
        if message.get('steps'):
            return False
        return True

    def info(self):
        return {'id': self.id, 'conversation_id': self.cid, 'status': self.status}

    def snapshot(self):
        return {'event': 'snapshot', 'turn_id': self.id, 'conversation_id': self.cid,
                'cursor': self.sequence, 'message': copy.deepcopy(self.assistant)}

    def publish(self, event):
        self.sequence += 1
        item = dict(event, turn_id=self.id, cursor=self.sequence)
        self.history.append((self.sequence, item))
        self.updated_at = time.time()
        self.changed.set()

    def save(self, force=False):
        if not self.cid or (not force and time.monotonic() - self.saved_at < 1):
            return
        # Synchronous replace serializes with API snapshot writes on this event loop.
        path = self.manager.directory / (self.cid + '.json')
        temporary = path.with_name(path.name + '.' + self.id + '.tmp')
        temporary.write_text(json.dumps(self.manager.serializable(self.messages), ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(path)
        self.saved_at = time.monotonic()

    def _text_for(self, message: dict):
        raw, final = message['rawText'], message['finalResponse']
        streamed, complete = _extract(raw, self.status == 'running'), _extract(final)
        inline = complete['thinking'] if raw and final.startswith(raw) else streamed['thinking']
        final_thought = complete['thinking']
        if final_thought and not (final and raw.endswith(final)):
            if not inline or final_thought.startswith(inline):
                inline = final_thought
            elif not inline.startswith(final_thought):
                inline += '\n\n' + final_thought
        separate = message['eventThinking'].strip()
        message['thinking'] = '\n\n'.join(value for value in ('' if separate == '...' else separate, inline) if value)
        message['content'] = (complete['content'] or streamed['content']) + message['errorText']

    def text(self):
        self._text_for(self.assistant)

    @staticmethod
    def _iso_now():
        now = time.time()
        return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(now)) + f'.{int(now * 1000) % 1000:03d}Z'

    @staticmethod
    def _normalize_tool_status(raw_status):
        value = str(raw_status or 'running').strip().lower()
        if value in ('error', 'failed'):
            return 'error'
        if value in ('completed', 'done', 'success', 'succeeded'):
            return 'completed'
        return 'running'

    def _next_step_id(self, prefix: str, owner: dict | None = None) -> str:
        self._step_seq += 1
        target = owner if owner is not None else self.assistant
        return f"{target['id']}:{prefix}:{self._step_seq}"

    def _sync_inline_step(self, step: dict, streaming: bool, owner: dict | None = None):
        raw_text = self._step_raw.get(step['id'], '')
        parsed = _extract(raw_text, streaming)
        step['content'] = parsed['content']
        inline_thought = parsed['thinking']
        if inline_thought:
            target_owner = owner if owner is not None else self.assistant
            steps = target_owner.setdefault('steps', [])
            think_id = step['id'] + ':think'
            existing = next((s for s in steps if s.get('id') == think_id), None)
            if existing is not None:
                existing['content'] = inline_thought
            else:
                idx = steps.index(step)
                steps.insert(idx, {
                    'id': think_id,
                    'type': 'thinking',
                    'content': inline_thought,
                    'timestamp': step.get('timestamp') or self._iso_now(),
                })

    def _finalize_steps_for(self, message: dict, *, keep_running_tools: bool = False):
        steps = message.setdefault('steps', [])
        for step in list(steps):
            if step.get('type') == 'text' and step.get('id') in self._step_raw:
                self._sync_inline_step(step, False, message)
        terminal_tool_status = 'completed' if self.status == 'complete' else 'error'
        cleaned = []
        for step in steps:
            stype = step.get('type')
            if stype == 'tool_use':
                if not keep_running_tools and step.get('status') == 'running':
                    step['status'] = terminal_tool_status
                cleaned.append(step)
            elif stype in ('text', 'thinking'):
                if str(step.get('content') or '').strip():
                    cleaned.append(step)
            else:
                cleaned.append(step)
        if message.get('content') and not any(s.get('type') == 'text' and str(s.get('content') or '').strip() for s in cleaned):
            cleaned.append({
                'id': self._next_step_id('text', message),
                'type': 'text',
                'content': message['content'],
                'timestamp': self._iso_now(),
            })
        message['steps'] = cleaned

    def finalize_steps(self):
        self._finalize_steps_for(self.assistant, keep_running_tools=False)

    def _find_tool_step(self, tool_id: str, *, fallback_running: bool = False):
        if tool_id:
            for owner in reversed(self._turn_assistants):
                steps = owner.get('steps') or []
                match = next((s for s in steps if s.get('type') == 'tool_use' and s.get('toolId') == tool_id), None)
                if match is not None:
                    return owner, match
        if fallback_running:
            for owner in reversed(self._turn_assistants):
                steps = owner.get('steps') or []
                match = next((s for s in reversed(steps) if s.get('type') == 'tool_use' and s.get('status') == 'running'), None)
                if match is not None:
                    return owner, match
        return None, None

    def absorb(self, event):
        message, kind = self.assistant, event.get('event')
        meta: dict = {}
        if kind == 'init' and event.get('conversation_id'):
            cid = event['conversation_id']
            if not re.fullmatch(r'[A-Za-z0-9_.-]{1,200}', cid):
                raise ValueError('Invalid conversation ID returned by CLI')
            self.cid = cid
            self.manager.by_conversation[cid] = self.id
        if kind == 'user_message_applied':
            msg_uuid = str(event.get('uuid') or '')
            next_assistant = self._pending_segments.pop(msg_uuid, None)
            if next_assistant is None and self._pending_segments:
                first_key = next(iter(self._pending_segments))
                next_assistant = self._pending_segments.pop(first_key)
                msg_uuid = msg_uuid or first_key
            if next_assistant is not None:
                prev = self.assistant
                self._text_for(prev)
                self._finalize_steps_for(prev, keep_running_tools=True)
                if prev.get('routeInfo') and not next_assistant.get('routeInfo'):
                    next_assistant['routeInfo'] = copy.deepcopy(prev['routeInfo'])
                if self._is_empty_assistant(prev):
                    if prev in self.messages:
                        self.messages.remove(prev)
                    if prev in self._turn_assistants:
                        self._turn_assistants.remove(prev)
                else:
                    prev['status'] = 'complete'
                self.assistant = next_assistant
                meta['user_message_id'] = msg_uuid
                meta['previous_assistant_id'] = prev['id']
                meta['assistant'] = copy.deepcopy(self.assistant)
            return meta
        if event.get('route_info'):
            message['routeInfo'] = copy.deepcopy(event['route_info'])
        if kind == 'delta':
            chunk = str(event.get('delta') or event.get('text') or '')
            message['rawText'] += chunk
            message['status'] = 'streaming'
            if chunk:
                steps = message.setdefault('steps', [])
                if steps and steps[-1].get('type') == 'text':
                    step = steps[-1]
                else:
                    step = {'id': self._next_step_id('text'), 'type': 'text', 'content': '', 'timestamp': self._iso_now()}
                    steps.append(step)
                self._step_raw[step['id']] = self._step_raw.get(step['id'], '') + chunk
                self._sync_inline_step(step, self.status == 'running')
                meta['step_id'] = step['id']
        elif kind == 'thinking':
            chunk = str(event.get('thinking', event.get('delta', '')))
            step = event.get('step_index')
            order = message['thinkingOrder']
            steps = message.setdefault('steps', [])
            if isinstance(step, int) and not isinstance(step, bool) and step >= 0:
                part = next((value for value in order if value.get('step_index') == step), None)
                if part is None:
                    part = {'step_index': step, 'text': ''}; order.append(part)
                part['text'] = chunk if event.get('mode') == 'snapshot' else part['text'] + chunk
                target = next((s for s in steps if s.get('type') == 'thinking' and s.get('stepIndex') == step), None)
                if target is None:
                    target = {'id': self._next_step_id('thinking'), 'type': 'thinking', 'stepIndex': step, 'content': '', 'timestamp': self._iso_now()}
                    steps.append(target)
                target['content'] = chunk if event.get('mode') == 'snapshot' else target['content'] + chunk
                meta['step_id'] = target['id']
            elif chunk:
                if order and 'step_index' not in order[-1]:
                    order[-1]['text'] += chunk
                else:
                    order.append({'text': chunk})
                if steps and steps[-1].get('type') == 'thinking' and 'stepIndex' not in steps[-1]:
                    target = steps[-1]
                    target['content'] += chunk
                else:
                    target = {'id': self._next_step_id('thinking'), 'type': 'thinking', 'content': chunk, 'timestamp': self._iso_now()}
                    steps.append(target)
                meta['step_id'] = target['id']
            message['eventThinking'] = '\n\n'.join(value['text'] for value in order if value['text'])
            if event.get('mode') != 'snapshot':
                message['status'] = 'streaming'
        elif kind == 'tool_result':
            tool_id = str(event.get('tool_id') or event.get('toolId') or '')
            owner, target = self._find_tool_step(tool_id, fallback_running=True)
            if target is not None:
                is_err = bool(event.get('is_error') or event.get('isError'))
                result_obj = {'content': str(event.get('content') or ''), 'isError': is_err}
                if event.get('tool_use_result') is not None:
                    result_obj['toolUseResult'] = event.get('tool_use_result')
                target['toolResult'] = result_obj
                target['status'] = 'error' if is_err else 'completed'
                meta['step_id'] = target['id']
                meta['tool_id'] = target['toolId']
                if owner is not None and owner is not message:
                    meta['assistant_id'] = owner['id']
        elif kind == 'tool' or event.get('tool'):
            tool_label = str(event.get('tool') or event.get('name') or 'executing')
            message['tool'] = tool_label
            steps = message.setdefault('steps', [])
            raw_tool_id = str(event.get('tool_id') or event.get('toolId') or '')
            tool_name = str(event.get('tool_name') or event.get('toolName') or event.get('name') or tool_label)
            tool_input = event['tool_input'] if 'tool_input' in event and event['tool_input'] is not None else event.get('args')
            mapped_status = self._normalize_tool_status(event.get('status'))
            owner, target = self._find_tool_step(raw_tool_id, fallback_running=False)
            if target is None:
                owner = message
                tool_id = raw_tool_id or self._next_step_id('tool')
                target = {
                    'id': f"{message['id']}:tool:{tool_id}",
                    'type': 'tool_use',
                    'toolId': tool_id,
                    'toolName': tool_name,
                    'toolLabel': tool_label,
                    'toolInput': tool_input if tool_input is not None else {'summary': tool_label},
                    'status': mapped_status,
                    'timestamp': self._iso_now(),
                }
                steps.append(target)
            else:
                generic_names = ('', 'tool', 'executing')
                if tool_name and (tool_name.strip().lower() not in generic_names or str(target.get('toolName') or '').strip().lower() in generic_names):
                    target['toolName'] = tool_name
                if tool_label and (tool_label.strip().lower() not in generic_names or str(target.get('toolLabel') or '').strip().lower() in generic_names):
                    target['toolLabel'] = tool_label
                if tool_input is not None:
                    target['toolInput'] = tool_input
                target['status'] = mapped_status
            if event.get('tool_output') is not None:
                is_err = bool(event.get('is_error') or event.get('isError')) or mapped_status == 'error'
                target['toolResult'] = {'content': str(event.get('tool_output')), 'isError': is_err}
                if mapped_status == 'running':
                    target['status'] = 'error' if is_err else 'completed'
            meta['step_id'] = target['id']
            meta['tool_id'] = target['toolId']
            if owner is not None and owner is not message:
                meta['assistant_id'] = owner['id']
        elif kind == 'result':
            if event.get('response'):
                message['finalResponse'] = str(event['response'])
            usage = event.get('usage')
            if usage:
                cache_read = usage.get('cache_read_tokens')
                if cache_read is None:
                    cache_read = usage.get('cache_read_input_tokens')
                cache_create = usage.get('cache_creation_tokens')
                if cache_create is None:
                    cache_create = usage.get('cache_creation_input_tokens')
                total = usage.get('total_tokens')
                if total is None:
                    total = (usage.get('input_tokens') or 0) + (usage.get('output_tokens') or 0)
                    if 'cache_read_input_tokens' in usage or 'cache_creation_input_tokens' in usage:
                        total += (cache_read or 0) + (cache_create or 0)
                details = []
                for key, label in (('input_tokens', '输入'), ('output_tokens', '输出'), ('thinking_tokens', '思考')):
                    if key in usage and (key in ('input_tokens', 'output_tokens') or usage[key]):
                        details.append(f'{label} {usage[key]:,}')
                if cache_read:
                    details.append(f'缓存 {cache_read:,}')
                if cache_create:
                    details.append(f'缓存写入 {cache_create:,}')
                parts = [f'{total:,} tokens'] + ([f"({' / '.join(details)})"] if details else [])
                if event.get('duration_seconds'):
                    parts.append(f"· ⏱️ {event['duration_seconds']:.1f}s")
                message['metrics'] = ' '.join(parts)
        elif kind == 'error' or event.get('error'):
            message['status'] = 'error'
            value = f"_Error: {event.get('error') or 'Unknown error'}_"
            if value not in message['errorText']:
                message['errorText'] += '\n\n' + value
        self.text()
        if kind == 'result' and message.get('content'):
            steps = message.setdefault('steps', [])
            if not any(s.get('type') == 'text' and str(s.get('content') or '').strip() for s in steps):
                step = {'id': self._next_step_id('text'), 'type': 'text', 'content': message['content'], 'timestamp': self._iso_now()}
                steps.append(step)
                meta['step_id'] = step['id']
        return meta

    async def run(self):
        outcome = 'error'
        try:
            self.save(True)
            async for event in self.stream:
                meta = self.absorb(event)
                self.save(event.get('event') in ('init', 'user_message_applied'))
                self.publish({**event, **meta} if meta else event)
            # Later deltas may follow an error; they must not erase its outcome.
            outcome = 'error' if any(asst.get('errorText') for asst in self._turn_assistants) else 'complete'
        except asyncio.CancelledError:
            outcome = 'stopped'
            self.assistant['errorText'] += '\n\n_Stopped: Response cancelled_'
        except Exception as error:
            outcome = 'error'
            self.absorb({'event': 'error', 'error': str(error)})
            self.publish({'event': 'error', 'error': str(error)})
            self.manager.logger.warning('Chat stream failed (%s)', type(error).__name__)
        finally:
            try:
                await self.stream.aclose()
            finally:
                self.status = outcome
                self._pending_segments.clear()
                for asst in list(self._turn_assistants):
                    self._text_for(asst)
                    self._finalize_steps_for(asst, keep_running_tools=False)
                    if asst is not self.assistant and self._is_empty_assistant(asst):
                        if asst in self.messages:
                            self.messages.remove(asst)
                        self._turn_assistants.remove(asst)
                        continue
                    if asst is self.assistant or asst.get('status') == 'streaming':
                        asst['status'] = self.status
                if (
                    self.status == 'complete'
                    and self._is_empty_assistant(self.assistant)
                    and len(self._turn_assistants) > 1
                ):
                    if self.assistant in self.messages:
                        self.messages.remove(self.assistant)
                    self._turn_assistants.remove(self.assistant)
                    self.assistant = self._turn_assistants[-1]
                try:
                    self.save(True)
                except Exception:
                    self.manager.logger.exception('Could not save background reply')
                self.publish(self.snapshot())
                self.publish({'event': 'done', 'status': self.status})

    async def events(self, cursor=0, heartbeat=15):
        yield dict({'event': 'start', 'turn_id': self.id, 'conversation_id': self.cid}, cursor=cursor)
        if not cursor or (self.history and cursor < self.history[0][0] - 1):
            yield self.snapshot()
            cursor = self.sequence
        while True:
            self.changed.clear()
            if self.history and cursor < self.history[0][0] - 1:
                yield self.snapshot()
                cursor = self.sequence
            available = [(number, event) for number, event in self.history if number > cursor]
            for number, event in available:
                cursor = number
                yield event
            if self.status != 'running' and cursor >= self.sequence:
                if not available or available[-1][1].get('event') != 'done':
                    yield {'event': 'done', 'turn_id': self.id, 'status': self.status, 'cursor': cursor}
                return
            try:
                await asyncio.wait_for(self.changed.wait(), heartbeat)
            except asyncio.TimeoutError:
                yield None


class TurnManager:
    def __init__(self, directory: Path, logger):
        self.directory, self.logger = directory, logger
        self.turns, self.by_conversation = {}, {}
        self.cancelled_ids = {}

    @staticmethod
    def serializable(messages):
        runtime = {'rawText', 'finalResponse', 'eventThinking', 'thinkingOrder', 'thinkingByStep', 'errorText', 'isThinking', '_id'}
        return [{key: value for key, value in message.items() if key not in runtime} for message in messages]

    def start(self, stream_factory, cid, messages, model, model_label='', turn_id=None):
        self.prune()
        turn_id = turn_id or uuid.uuid4().hex
        if not re.fullmatch(r'[a-f0-9]{32}', turn_id):
            raise ValueError('Invalid turn ID')
        if turn_id in self.turns:
            raise ValueError('This turn has already been submitted')
        if turn_id in self.cancelled_ids:
            raise ValueError('This turn was explicitly stopped before starting')
        previous = self.for_conversation(cid)
        if previous and previous.status == 'running':
            raise ValueError('This conversation is still running')
        job = WebTurn(self, turn_id, stream_factory(), cid, messages, model, model_label)
        self.turns[turn_id] = job
        if cid:
            self.by_conversation[cid] = turn_id
        job.task = asyncio.create_task(job.run(), name='agy-web-turn-' + turn_id)
        return job

    def for_conversation(self, cid):
        return self.turns.get(self.by_conversation.get(cid)) if cid else None

    def protect(self, cid, messages, transport_turn_id=None):
        job = self.for_conversation(cid)
        if not job or (job.status != 'running' and transport_turn_id != job.id):
            return messages
        # A reader's partial/error snapshot must not replace the server-owned reply
        # or any mid-turn injected follow-ups belonging to this turn.
        incoming_by_id = {
            value.get('id'): value
            for value in messages
            if isinstance(value, dict) and value.get('turnId') == job.id and value.get('role') == 'assistant' and value.get('id')
        }
        incoming_first_asst = next(
            (value for value in messages if isinstance(value, dict) and value.get('turnId') == job.id and value.get('role') == 'assistant'),
            None,
        )
        for asst in job._turn_assistants:
            matched = incoming_by_id.get(asst.get('id')) or (incoming_first_asst if asst is job.assistant else None)
            if matched and 'thoughtOpen' in matched:
                asst['thoughtOpen'] = matched['thoughtOpen']
        prefix = [copy.deepcopy(value) for value in messages if not (isinstance(value, dict) and value.get('turnId') == job.id)]
        owned = [value for value in job.messages if isinstance(value, dict) and value.get('turnId') == job.id]
        result = prefix + owned
        job.messages = result
        return result

    async def inject(self, turn_id, content: str, *, formatted_prompt: str, attachments=None, message_id: str | None = None):
        job = self.turns.get(turn_id)
        if not job or job.status != 'running':
            return None
        return await job.inject(
            content,
            formatted_prompt=formatted_prompt,
            attachments=attachments,
            message_id=message_id,
        )

    async def stop(self, turn_id):
        job = self.turns.get(turn_id)
        if not job:
            if not re.fullmatch(r'[a-f0-9]{32}', turn_id):
                return None
            self.cancelled_ids[turn_id] = time.time()
            return {'id': turn_id, 'conversation_id': None, 'status': 'stopped'}
        if job.status == 'running' and not job.stop_requested:
            job.stop_requested = True
            job.task.cancel()
            try:
                await job.task
            except asyncio.CancelledError:
                # Stop may arrive before asyncio first enters the worker.
                job.status = job.assistant['status'] = 'stopped'
                job.assistant['errorText'] += '\n\n_Stopped: Response cancelled_'
                job.text()
                job.finalize_steps()
                job.save(True)
                job.publish(job.snapshot())
                job.publish({'event': 'done', 'status': 'stopped'})
        return job.info()

    def prune(self):
        for turn_id, created in list(self.cancelled_ids.items()):
            if time.time() - created > 3600:
                self.cancelled_ids.pop(turn_id)
        for turn_id, job in list(self.turns.items()):
            if job.status != 'running' and time.time() - job.updated_at > 3600:
                self.turns.pop(turn_id)
                if self.by_conversation.get(job.cid) == turn_id:
                    self.by_conversation.pop(job.cid)
