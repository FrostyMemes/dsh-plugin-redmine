export interface OnceCell { current: boolean }

export function claimOnce(cell: OnceCell): boolean {
  if (cell.current) return false;
  cell.current = true;
  return true;
}
