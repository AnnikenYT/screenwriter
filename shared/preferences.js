export const DEFAULT_TITLE_PAGE_ALIGNMENT = 'center';
export const TITLE_PAGE_ALIGNMENTS = ['left', DEFAULT_TITLE_PAGE_ALIGNMENT, 'right'];

export function titlePageAlignment(value) {
  return TITLE_PAGE_ALIGNMENTS.includes(value) ? value : DEFAULT_TITLE_PAGE_ALIGNMENT;
}
