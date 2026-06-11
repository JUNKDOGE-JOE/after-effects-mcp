import React from 'react';
import { Icon } from '../core/Icon';
import { Input } from '../forms/Input';
import { Select } from '../forms/Select';

export function FilterBar({
  query = '',
  onQuery,
  searchPlaceholder = '搜索操作…',
  filters = [],
  style,
}) {
  return (
    <div style={{ display: 'flex', gap: 'var(--space-15)', padding: 'var(--space-2)', borderBottom: '1px solid var(--border-subtle)', ...style }}>
      <Input
        value={query}
        onChange={onQuery}
        placeholder={searchPlaceholder}
        style={{ flex: 1 }}
        suffix={null}
      />
      {filters.map((f, i) => (
        <Select key={i} full={false} value={f.value} onChange={f.onChange} options={f.options} style={{ flex: 'none', width: f.width || 96 }} />
      ))}
    </div>
  );
}
