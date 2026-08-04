/**
 * Non-HTTP Worker exports. Flue re-exports everything here from the
 * generated Worker entry.
 *
 * `WorkspaceServiceProxy` must be an entry-module export: the
 * cloudflare-computer sandbox's shell backend mints a loopback binding for
 * it (`ctx.exports.WorkspaceServiceProxy`), and Cloudflare only mints
 * loopbacks for classes exported from the Worker's entry.
 */
export { WorkspaceServiceProxy } from '@cloudflare/computer';
