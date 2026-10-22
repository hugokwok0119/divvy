// Member colors in household order. The first five are the original palette, so
// existing members keep their colors. The rest avoid the app's own UI colors
// (indigo-600, green-700, slate-600) and alternate hues so neighbors differ.
export const MEMBER_COLORS = [
  '#f59e0b', '#3b82f6', '#ec4899', '#84cc16', '#8b5cf6',
  '#059669', '#dc2626', '#0891b2', '#c026d3', '#c2410c',
  '#3f6212', '#0f766e', '#be123c', '#0369a1', '#a16207',
  '#7e22ce', '#ea580c', '#0d9488', '#92400e', '#9d174d',
];

// shortcut: colors repeat from the 21st member; extend the list if households grow past 20.
export const memberColorAt = (index: number) => MEMBER_COLORS[index % MEMBER_COLORS.length];
