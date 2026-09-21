/**
 * Exporting a design document to a new tab or to disk.
 *
 * The in-app pane renders the document in `sandbox=""`, where nothing can
 * execute. A blob: URL does NOT get that for free: a blob created by this page
 * inherits THIS page's origin, so a script inside the document would run
 * same-origin with the app and could read the session id out of localStorage
 * or talk to the server.
 *
 * Stripping `<script>` with a regex is not a defence — `onerror=alert(1)`
 * without quotes, `<scr<script>ipt>`, `javascript:` URLs and svg/xlink tricks
 * all walk past it, and a sanitiser that is 90% effective just moves the bug.
 *
 * So the export never relies on cleaning the document. It opens a wrapper page
 * whose only content is the design inside a `sandbox=""` iframe: scripts are
 * inert because the sandbox says so, not because we think we removed them.
 * External images, stylesheets and webfonts still load, which is what keeps
 * the preview faithful.
 */

/**
 * Escape for use inside a double-quoted HTML attribute. `&` must go first, or
 * it would double-escape the entities produced afterwards. With `"` escaped a
 * payload cannot close the attribute and break back out into markup, so `<`
 * inside the value stays inert attribute text.
 */
export function escapeForSrcdoc(html: string): string {
  return html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** A minimal page that shows `html` in a sandboxed, full-viewport iframe. */
export function sandboxedWrapper(html: string, title: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeForSrcdoc(title)}</title>`,
    "<style>html,body{margin:0;height:100%;background:#fff}",
    "iframe{border:0;display:block;width:100%;height:100%}</style>",
    "</head><body>",
    `<iframe sandbox="" srcdoc="${escapeForSrcdoc(html)}"></iframe>`,
    "</body></html>",
  ].join("");
}

/**
 * Downloads are served as a byte stream rather than text/html so that opening
 * the blob URL directly renders nothing; the `download` attribute still gives
 * the file its name. Once saved and opened from disk it is an ordinary local
 * file on its own origin, like any other download.
 */
export const DOWNLOAD_MIME = "application/octet-stream";
