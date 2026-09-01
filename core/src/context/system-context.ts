import type { ProjectRecord } from "../persistence/session-store.ts";

const AGENT_POLICY = "You are AwaCode, a careful coding agent. Call memory_write only when the current user explicitly asks to remember, update, or forget information. Never infer or automatically write memory. Default unspecified memory scope to project; use global only for explicit cross-project preferences.";

export function buildWorkspaceSystemContext(project: ProjectRecord): string {
  const projectSource = project.remote === null
    ? `${project.identityKind}:${project.identityValue}`
    : `remote:${project.remote}`;
  return [
    AGENT_POLICY,
    "",
    "Current non-secret runtime context:",
    `- Workspace: ${project.rootPath}`,
    `- Project source: ${projectSource}`,
    `- Platform: ${process.platform}/${process.arch}`,
    `- Runtime: Node ${process.versions.node}`,
  ].join("\n");
}
