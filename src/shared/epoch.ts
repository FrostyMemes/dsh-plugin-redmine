export interface EpochCell { current: number }

export function advanceEpoch(cell: EpochCell): number {
  cell.current++;
  return cell.current;
}

export function isCurrentEpoch(cell: EpochCell, expected: number): boolean {
  return cell.current === expected;
}
