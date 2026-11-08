package dev.bloodyi.mintcli.mobile;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** Validates workspace addresses and confines the in-app browser to one origin. */
public final class ConnectionPolicy {
    private ConnectionPolicy() {}

    public static String normalize(String input) {
        if (input == null || input.trim().isEmpty()) {
            throw new IllegalArgumentException("请输入工作区网址");
        }
        String value = input.trim();
        if (!value.contains("://")) {
            // Host:port is accepted; executable URL schemes are never inferred as hosts.
            if (value.matches("(?i)^(javascript|data|file|content|intent|about|blob):.*")) {
                throw new IllegalArgumentException("工作区网址仅支持 HTTP 或 HTTPS");
            }
            value = "https://" + value;
        }
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if ((!scheme.equals("https") && !scheme.equals("http")) || uri.getHost() == null
                    || uri.getRawUserInfo() != null || uri.getRawFragment() != null
                    || uri.getRawQuery() != null || uri.getPort() == 0 || uri.getPort() > 65535) {
                throw new IllegalArgumentException("请输入完整工作区地址，不含账号、查询参数或片段");
            }
            String normalized = uri.normalize().toASCIIString();
            return uri.getRawPath() == null || uri.getRawPath().isEmpty() ? normalized + "/" : normalized;
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("工作区网址格式无效");
        }
    }

    public static boolean sameOrigin(String trusted, String candidate) {
        try {
            URI a = new URI(trusted);
            URI b = new URI(candidate);
            return a.getHost() != null && b.getHost() != null && b.getRawUserInfo() == null
                    && a.getScheme().equalsIgnoreCase(b.getScheme())
                    && a.getHost().equalsIgnoreCase(b.getHost()) && port(a) == port(b);
        } catch (URISyntaxException | NullPointerException e) {
            return false;
        }
    }

    private static int port(URI uri) {
        if (uri.getPort() >= 0) return uri.getPort();
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }
}
