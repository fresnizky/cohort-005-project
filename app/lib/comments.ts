export const MIN_COMMENT_LENGTH = 1;
export const MAX_COMMENT_LENGTH = 5000;

/**
 * The stable anchor id a comment gets on the lesson page, so a link can land
 * on it (`#comment-42`). Notifications link to it.
 */
export function commentAnchorId(commentId: number): string {
  return `comment-${commentId}`;
}
