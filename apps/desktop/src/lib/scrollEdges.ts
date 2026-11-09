// A scrolling view in a pane (X94): which edges have more to show, where a
// fade covers them, and whether the end is far enough away to offer Latest.

/** WebKit leaves a fraction of a pixel at either end. */
const SLACK = 1;
/** Further than this from the end, Latest shows. */
const FAR = 240;

export function scrollEdges(view: { scrollTop: number; scrollHeight: number; clientHeight: number }): { atTop: boolean; atBottom: boolean; far: boolean } {
  const left = view.scrollHeight - view.clientHeight - view.scrollTop;
  return { atTop: view.scrollTop <= SLACK, atBottom: left <= SLACK, far: left > FAR };
}
