import { useState } from 'react';
import { AgentConnections } from '@/modules/agent-connections';
import type { LLMProvider, ProviderAuthStatusMap } from '@/shared/types';

const ignoreChoice = () => {};

/** Used by Onboarding to expose the same account manager as the chat workspace. */
export default function AgentConnectionsStep(_props: { providerStatuses: ProviderAuthStatusMap; onOpenProviderLogin: (provider: LLMProvider) => void }) {
  // The setup flow can inspect each provider without creating a chat session.
  const [provider, setProvider] = useState<LLMProvider>('codex');
  return <div className="space-y-4">
    <h2 className="text-center text-xl font-semibold">连接编程账号</h2>
    <p className="text-center text-sm text-muted-foreground">登录、账号切换和额度检查都在统一账号管理中完成，也可以稍后设置。</p>
    <AgentConnections provider={provider} disabled={false} onChoice={ignoreChoice} onProviderChange={setProvider} />
  </div>;
}
