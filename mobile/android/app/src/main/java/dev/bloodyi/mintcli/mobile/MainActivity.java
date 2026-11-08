package dev.bloodyi.mintcli.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/** The existing workspace stays on its own origin; phone tools are native screens. */
public final class MainActivity extends Activity {
    private static final int PICK_UPLOAD = 301;
    private static final int BACKGROUND = Color.rgb(16, 26, 25);
    private static final int MINT = Color.rgb(110, 231, 183);
    private WebView browser;
    private LinearLayout home;
    private TextView message;
    private ProgressBar progress;
    private SharedPreferences preferences;
    private volatile String workspace = "";
    private ValueCallback<Uri[]> uploadCallback;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        preferences = getSharedPreferences("mintcli-mobile", MODE_PRIVATE);
        workspace = preferences.getString("workspace", "");
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BACKGROUND);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars()
                        | android.view.WindowInsets.Type.displayCutout());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(android.view.Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(12), dp(6), dp(6), dp(6));
        TextView brand = new TextView(this);
        brand.setText("mintcli");
        brand.setTextSize(23);
        brand.setTextColor(MINT);
        brand.setTypeface(null, android.graphics.Typeface.BOLD);
        toolbar.addView(brand, new LinearLayout.LayoutParams(0, dp(48), 1));
        toolbar.addView(button("连接", this::connectionDialog));
        toolbar.addView(button("手机工具", this::openTools));
        root.addView(toolbar);
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setVisibility(View.GONE);
        root.addView(progress, new LinearLayout.LayoutParams(-1, dp(3)));

        home = new LinearLayout(this);
        home.setOrientation(LinearLayout.VERTICAL);
        home.setGravity(android.view.Gravity.CENTER_VERTICAL);
        home.setPadding(dp(28), dp(20), dp(28), dp(20));
        TextView title = new TextView(this);
        title.setText("你的工作区，\n随身携带。");
        title.setTextColor(Color.WHITE);
        title.setTextSize(32);
        home.addView(title);
        message = new TextView(this);
        message.setTextColor(Color.rgb(187, 208, 202));
        message.setTextSize(16);
        message.setPadding(0, dp(24), 0, dp(24));
        home.addView(message);
        home.addView(button("连接工作区", this::connectionDialog));
        home.addView(button("打开手机工具", this::openTools));
        home.addView(button("重新载入", this::loadWorkspace));
        root.addView(home, new LinearLayout.LayoutParams(-1, 0, 1));

        browser = new WebView(this);
        browser.setBackgroundColor(BACKGROUND);
        configureBrowser();
        root.addView(browser, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root);
        loadWorkspace();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureBrowser() {
        WebSettings settings = browser.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(browser, false);
        browser.setWebViewClient(new WebViewClient() {
            @Override public android.webkit.WebResourceResponse shouldInterceptRequest(
                    WebView view, WebResourceRequest request) {
                if (request.isForMainFrame() && !ConnectionPolicy.sameOrigin(workspace, request.getUrl().toString())) {
                    return new android.webkit.WebResourceResponse("text/plain", "UTF-8",
                            new java.io.ByteArrayInputStream("请在浏览器中打开此链接。"
                                    .getBytes(java.nio.charset.StandardCharsets.UTF_8)));
                }
                return null;
            }

            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                if (!ConnectionPolicy.sameOrigin(workspace, url)) {
                    view.stopLoading();
                    showHome("此链接需要在浏览器中打开，请重新载入工作区。");
                }
            }

            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String target = request.getUrl().toString();
                if (ConnectionPolicy.sameOrigin(workspace, target)) return false;
                if (request.isForMainFrame() && request.hasGesture()) openBrowser(target);
                return true;
            }

            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showHome("工作区暂时无法连接。请检查服务地址和手机网络。\n手机工具仍可直接使用。");
                }
            }
        });
        browser.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int value) {
                progress.setProgress(value);
                progress.setVisibility(value < 100 && browser.getVisibility() == View.VISIBLE ? View.VISIBLE : View.GONE);
            }

            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                                       FileChooserParams params) {
                if (uploadCallback != null) uploadCallback.onReceiveValue(null);
                uploadCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), PICK_UPLOAD);
                } catch (ActivityNotFoundException error) {
                    uploadCallback.onReceiveValue(null);
                    uploadCallback = null;
                    toast("未找到文件选择器");
                }
                return true;
            }

            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean userGesture,
                                                      android.os.Message result) {
                if (!userGesture) return false;
                WebView popup = new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    private void forward(String target) {
                        openBrowser(target);
                        popup.post(popup::destroy);
                    }
                    @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        forward(request.getUrl().toString());
                        return true;
                    }
                    @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) {
                        if (!"about:blank".equals(url)) forward(url);
                    }
                });
                ((WebView.WebViewTransport) result.obj).setWebView(popup);
                result.sendToTarget();
                return true;
            }
        });
        browser.setDownloadListener((url, agent, disposition, mime, length) -> openBrowser(url));
    }

    private void loadWorkspace() {
        if (workspace.isEmpty()) {
            showHome("连接你现有的 mintcli 服务，使用智能体、会话、项目和终端。\n文件与设备工具可在手机上直接使用。");
            return;
        }
        try {
            workspace = ConnectionPolicy.normalize(workspace);
        } catch (IllegalArgumentException error) {
            showHome(error.getMessage());
            return;
        }
        home.setVisibility(View.GONE);
        browser.setVisibility(View.VISIBLE);
        browser.loadUrl(workspace);
    }

    private void showHome(String text) {
        message.setText(text);
        browser.setVisibility(View.GONE);
        progress.setVisibility(View.GONE);
        home.setVisibility(View.VISIBLE);
    }

    private void connectionDialog() {
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(22), dp(8), dp(22), 0);
        TextView description = new TextView(this);
        description.setText("填写你现有的 mintcli 服务网址。Clash 使用手机上的 VPN 模式接管网络。");
        description.setPadding(0, 0, 0, dp(12));
        form.addView(description);
        EditText address = new EditText(this);
        address.setHint("https://你的工作区网址");
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setSingleLine(true);
        address.setText(workspace);
        form.addView(address);
        TextView status = new TextView(this);
        status.setText("HTTP 地址中的网页登录信息会通过未加密连接发送。");
        status.setTextSize(12);
        status.setPadding(0, dp(8), 0, dp(12));
        form.addView(status);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("连接工作区").setView(form)
                .setNegativeButton("取消", null).setNeutralButton("清除网页登录", null)
                .setPositiveButton("连接", null).create();
        dialog.setOnShowListener(unused -> {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
                try {
                    String next = ConnectionPolicy.normalize(address.getText().toString());
                    browser.stopLoading();
                    browser.clearHistory();
                    workspace = next;
                    preferences.edit().putString("workspace", next).apply();
                    dialog.dismiss();
                    loadWorkspace();
                } catch (IllegalArgumentException error) {
                    address.setError(error.getMessage());
                }
            });
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v -> {
                CookieManager.getInstance().removeAllCookies(value -> {
                    CookieManager.getInstance().flush();
                    android.webkit.WebStorage.getInstance().deleteAllData();
                    browser.clearCache(true);
                    browser.clearHistory();
                    dialog.dismiss();
                    loadWorkspace();
                });
            });
        });
        dialog.show();
    }

    private void openTools() {
        startActivity(new Intent(this, ToolsActivity.class));
    }

    private void openBrowser(String address) {
        Uri uri = Uri.parse(address);
        if (!"https".equalsIgnoreCase(uri.getScheme()) && !"http".equalsIgnoreCase(uri.getScheme())) {
            toast("此链接需要在浏览器中手动打开");
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException error) {
            toast("未找到浏览器");
        }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PICK_UPLOAD && uploadCallback != null) {
            Uri[] selected = WebChromeClient.FileChooserParams.parseResult(result, data);
            if (selected != null) {
                for (Uri uri : selected) {
                    String authority = uri == null ? null : uri.getAuthority();
                    if (uri == null || !"content".equalsIgnoreCase(uri.getScheme()) || authority == null
                            || authority.contains(getPackageName())) {
                        selected = null;
                        toast("请选择系统文件选择器中可访问的文件");
                        break;
                    }
                }
            }
            uploadCallback.onReceiveValue(selected);
            uploadCallback = null;
        }
    }

    @Override public void onBackPressed() {
        if (browser.getVisibility() == View.VISIBLE && browser.canGoBack()) browser.goBack();
        else super.onBackPressed();
    }

    @Override protected void onPause() {
        browser.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override protected void onResume() {
        super.onResume();
        if (browser != null) browser.onResume();
    }

    @Override protected void onDestroy() {
        if (uploadCallback != null) uploadCallback.onReceiveValue(null);
        browser.stopLoading();
        ((android.view.ViewGroup) browser.getParent()).removeView(browser);
        browser.destroy();
        super.onDestroy();
    }

    private Button button(String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(MINT);
        button.setOnClickListener(v -> action.run());
        return button;
    }

    private void toast(String text) { Toast.makeText(this, text, Toast.LENGTH_LONG).show(); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
