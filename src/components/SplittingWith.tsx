import React, { useState } from 'react';
import type { Member } from '../types';
import { memberColorAt } from '../lib/memberColors';

interface Props {
  members: Member[];
  canEdit: boolean;
  onToggle(id: string, sittingOut: boolean): Promise<void>;
}

/** Who new equal splits spread across. A chip is pressed while its member is in. */
const SplittingWith: React.FC<Props> = ({ members, canEdit, onToggle }) => {
  const [saving, setSaving] = useState(false);
  const toggle = async (member: Member) => {
    setSaving(true);
    try {
      await onToggle(member.id, member.sittingOutAt === null);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div role="group" aria-labelledby="splitting-with-label" aria-busy={saving} className="mb-3 flex flex-wrap items-center gap-2">
      <span id="splitting-with-label" className="text-body2 text-slate-500">Splitting with</span>
      {members.map((member, index) => {
        if (member.archivedAt !== null) return null;
        const isIn = member.sittingOutAt === null;
        const color = memberColorAt(index);
        return (
          <button
            key={member.id}
            type="button"
            aria-pressed={isIn}
            disabled={!canEdit || saving}
            onClick={() => void toggle(member)}
            style={isIn ? { borderColor: color, backgroundColor: `color-mix(in srgb, ${color} 14%, white)` } : undefined}
            className={`inline-flex min-h-11 items-center gap-2 rounded-full border-2 px-3 text-body1 disabled:cursor-default ${
              isIn ? 'font-semibold text-slate-900' : 'border-dashed border-slate-300 bg-white text-slate-500'
            } ${canEdit ? 'hover:shadow-sm' : ''} ${saving ? 'opacity-60' : ''}`}
          >
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: color, backgroundColor: isIn ? color : 'transparent' }} />
            {member.displayName}
            {!isIn && <span className="text-body2">Sitting out</span>}
          </button>
        );
      })}
    </div>
  );
};

export default SplittingWith;
