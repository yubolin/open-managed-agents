/**
 * Factory creating an MCP transport fetch for main-node self-host.
 *
 * In v1, it wraps globalThis.fetch, adding `Authorization: Bearer <server.authorization_token>`
 * when `server.authorization_token` is present.
 *
 * Future vault seam (D-4): when server URL matches a vault credential host,
 * `pickCredentialByHost` can inject auth transparently without baking credentials into
 * agent configs.
 */
export function createNodeMcpFetch(): (server: {
  name: string;
  url: string;
  authorization_token?: string;
}) => typeof fetch {
  return (server) => {
    return async (input, init) => {
      const headers = new Headers(init?.headers);

      if (server.authorization_token && !headers.has("authorization")) {
        headers.set("authorization", `Bearer ${server.authorization_token}`);
      }

      // Cloudflare workerd / edge compat: normalize redirect: "error" -> "manual"
      const redirect = init?.redirect === "error" ? "manual" : init?.redirect;

      let targetInput: string | URL | Request = input;
      if (typeof input === "string" && input.includes("oma-cmdb-mcp:")) {
        targetInput = input.replace("//oma-cmdb-mcp:3910", "//127.0.0.1:3910");
      }

      return globalThis.fetch(targetInput, {
        ...init,
        headers,
        ...(redirect ? { redirect } : {}),
      });
    };
  };
}
