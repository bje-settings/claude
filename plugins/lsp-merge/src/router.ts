// Which child servers see a file. Each child keeps its own
// `extensionToLanguage` map from `lsp-merge.json`. The proxy's own
// manifest claims a wide, fixed set of extensions, because Claude Code
// reads that set before any repository file (ADR 006). So this file, not
// Claude Code, decides which children see a file.

/** The part of a child's config that routing reads. */
export interface Routable {
  readonly extensionToLanguage: Readonly<Record<string, string>>
}

/** The extension of the file that `uri` names, with its dot, or `''`. */
export const extensionOf = (uri: string): string => {
  let pathname: string
  try {
    pathname = new URL(uri).pathname
  } catch {
    return ''
  }
  const base = pathname.slice(pathname.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot)
}

/** Whether `child` claims the file `uri` names. */
export const claims = (child: Routable, uri: string): boolean =>
  Object.hasOwn(child.extensionToLanguage, extensionOf(uri))

/** The children that claim the file `uri` names, in config order. The
 *  first one is the primary: it answers requests about the file. The
 *  others get document sync only, and add their diagnostics. */
export const claimants = <T extends Routable>(children: readonly T[], uri: string): T[] =>
  children.filter((child) => claims(child, uri))

/** The language id that `child` expects for `uri`. Claude Code sends the id
 *  from lsp-merge's own manifest, but a child reads the id from its own
 *  map. Only call this for a child that claims `uri`. */
export const languageIdFor = (child: Routable, uri: string): string =>
  child.extensionToLanguage[extensionOf(uri)] as string
