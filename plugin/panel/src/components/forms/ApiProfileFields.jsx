import React from 'react';
import { Button } from '../core/Button';
import { Field } from './Field';
import { Input } from './Input';

export function ApiProfileFields({ baseUrl, apiKey }) {
  return (
    <React.Fragment>
      <Field label={baseUrl.label} caption={baseUrl.caption}>
        <Input
          mono
          value={baseUrl.value}
          onChange={baseUrl.onChange}
          placeholder={baseUrl.placeholder}
        />
      </Field>
      <Field label={apiKey.label} caption={apiKey.caption}>
        <div style={{ display: 'flex', gap: 6 }}>
          <Input
            secret
            value={apiKey.value}
            onChange={apiKey.onChange}
            placeholder={apiKey.placeholder}
            style={{ flex: 1 }}
          />
          <Button variant="primary" disabled={apiKey.busy || apiKey.saveDisabled} onClick={apiKey.onSave}>
            {apiKey.saveLabel}
          </Button>
          <Button variant="secondary" disabled={apiKey.busy} onClick={apiKey.onClear}>
            {apiKey.clearLabel}
          </Button>
        </div>
      </Field>
    </React.Fragment>
  );
}
