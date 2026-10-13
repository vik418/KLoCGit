import { DurableObject } from "cloudflare:workers";

/** Preserve the previous namespace and its audit data during the cutover. */
export class WorkspaceCoordinator extends DurableObject {
  async fetch(): Promise<Response> {
    return new Response("This coordinator is archived.", { status: 410 });
  }
}

export class GitExecutorContainer extends DurableObject {
  async fetch(): Promise<Response> {
    return new Response("This executor is archived.", { status: 410 });
  }
}
