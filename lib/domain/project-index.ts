export type ProjectSort = 'createdAt' | 'lastOpenedAt' | 'updatedAt' | 'name';
export function sortProjects<T extends {id: string; name: string; createdAt?: string; lastOpenedAt?: string; updatedAt?: string}>(projects: T[], field: ProjectSort, direction: 'asc' | 'desc'): T[] {
  return [...projects].sort((a,b) => {
    const av = a[field], bv = b[field];
    // Unknown dates always remain at the end, including ascending order.
    if (field !== 'name') {
      const aTime = av ? Date.parse(av) : Number.NaN;
      const bTime = bv ? Date.parse(bv) : Number.NaN;
      const aKnown = Number.isFinite(aTime);
      const bKnown = Number.isFinite(bTime);
      if (!aKnown && bKnown) return 1;
      if (aKnown && !bKnown) return -1;
      const difference = (aKnown ? aTime : 0) - (bKnown ? bTime : 0);
      return (direction === 'asc' ? difference : -difference) || a.id.localeCompare(b.id);
    }
    const difference = (av || '').localeCompare(bv || '', 'zh-CN', {numeric: true});
    return (direction === 'asc' ? difference : -difference) || a.id.localeCompare(b.id);
  });
}
