import { authorize } from "../../src/authz/authorize";
import {
  authorizeHttp,
  HTTP_POLICY,
  type HttpRouteId,
} from "../../src/authz/http-policy";
import { DENIED_RPC_METHODS, RPC_POLICY } from "../../src/authz/policy";
import { MATRIX_ROLES, PRINCIPALS, testDeps } from "./principals";

/**
 * The authorization matrix over every RPC method and HTTP route in the
 * policy tables: for each, the roles (of admin, owner, editor, viewer,
 * outsider, share-link guest, and a guest whose link shows only pane `w1:p1`)
 * that may call it with a request naming workspace `w1`. Tests compare it
 * with the reviewed table in `authorize.test.ts`.
 */

/** Every identifier naming workspace `w1` (terminal `t1` lives there). */
export const W1_PARAMS = {
  workspace_id: "w1",
  tab_id: "w1:t1",
  pane_id: "w1:p1",
  terminal_id: "t1",
} as const;

export async function rpcMatrix(): Promise<Record<string, string>> {
  const methods = [
    ...Object.keys(RPC_POLICY),
    ...Object.keys(DENIED_RPC_METHODS),
    "workspace.get",
  ].sort();
  const matrix: Record<string, string> = {};
  for (const method of methods) {
    const allowed: string[] = [];
    for (const role of MATRIX_ROLES) {
      const decision = await authorize(
        {
          principal: PRINCIPALS[role],
          method,
          params: { ...W1_PARAMS },
          connectionId: "c1",
          participantId: `web-${role}`,
        },
        testDeps(),
      );
      // A stubbed reply exercises nothing.
      if (decision.allowed && !decision.stub) allowed.push(role);
    }
    matrix[method] = allowed.join(" ") || "-";
  }
  return matrix;
}

export async function httpMatrix(): Promise<Record<string, string>> {
  const matrix: Record<string, string> = {};
  for (const route of Object.keys(HTTP_POLICY).sort() as HttpRouteId[]) {
    const allowed: string[] = [];
    for (const role of [...MATRIX_ROLES, "anonymous"] as const) {
      const decision = await authorizeHttp({
        route,
        principal: role === "anonymous" ? null : PRINCIPALS[role],
        connectionId: route.startsWith("connection.") ? "c1" : null,
        query: new URLSearchParams({
          connection_id: "c1",
          workspace_id: "w1",
          pane_id: "w1:p1",
        }),
        deps: testDeps(),
        editsConnection: (principal, connectionId) =>
          (connectionId === null || connectionId === "c1") &&
          (principal === PRINCIPALS.owner ||
            principal === PRINCIPALS.editor ||
            principal === PRINCIPALS.outsider),
      });
      if (decision.ok) allowed.push(role);
    }
    matrix[route] = allowed.join(" ") || "-";
  }
  return matrix;
}

if (import.meta.main) {
  console.log(JSON.stringify(await rpcMatrix(), null, 2));
  console.log(JSON.stringify(await httpMatrix(), null, 2));
}
