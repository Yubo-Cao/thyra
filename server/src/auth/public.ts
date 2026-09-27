import { type HttpRouteId, matchHttpRoute } from "../authz/http-policy";
import type { PublicAuthenticator } from "../http/public-auth";
import type { Authenticator } from "./principal";
import type { AuthRoutes } from "./routes";

/** Routes the public listener serves before any session check. */
const PUBLIC_AUTH_ROUTES: ReadonlySet<HttpRouteId> = new Set([
  "login.page",
  "enroll.page",
  "login.script",
  "passkey.login",
  "passkey.register",
  "logout",
]);

/**
 * Accounts and passkeys on the public listener. `authenticator` must use
 * `__Host-` cookies with tailnet login off and no local bypass.
 */
export function createPublicAuthenticator(args: {
  authenticator: Authenticator;
  routes: AuthRoutes;
}): PublicAuthenticator {
  return {
    async handle(req, url, context) {
      const route = matchHttpRoute(req.method, url.pathname);
      if (!route || !PUBLIC_AUTH_ROUTES.has(route)) return null;
      const auth =
        route === "logout" || route === "login.script"
          ? { principal: null }
          : await args.authenticator.authenticate(req, context.access);
      if (route === "login.page" && auth.principal) {
        const headers = new Headers({
          location: "/",
          "cache-control": "no-store",
        });
        if (auth.setCookie) headers.append("set-cookie", auth.setCookie);
        return new Response(null, { status: 303, headers });
      }
      const response = await args.routes.handle(
        route,
        req,
        url,
        context.access,
        auth.principal,
      );
      if (!response || !auth.setCookie) return response;
      const headers = new Headers(response.headers);
      headers.append("set-cookie", auth.setCookie);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
    authenticate: (req, context) =>
      args.authenticator.authenticate(req, context.access),
  };
}
