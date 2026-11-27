import { useState } from 'react';
import { commit, getDb, getUser, isServer, serverAction } from '../store.js';
import { t } from '../i18n.js';
import { uploadMoves } from './uploadMoves.js';

const readFile = (file) => new Promise((resolve, reject) => {
  if (file.size > 2 * 1024 * 1024) return reject(new Error('File is larger than 2 MB'));
  const reader = new FileReader();
  reader.onerror = () => reject(new Error('Could not read file'));
  reader.onload = () => resolve({ name: file.name, type: file.type, size: file.size, data: String(reader.result) });
  reader.readAsDataURL(file);
});

const translateUploadError = (message) => {
  const direct = t(message);
  if (direct !== message) return direct;
  const sep = message.indexOf(': ');
  if (sep > 0) return `${message.slice(0, sep)}: ${t(message.slice(sep + 2))}`;
  return message;
};

export function useMoveUpload(options) {
  const [busy, setBusy] = useState(false);
  const upload = async (input) => {
    const files = Array.from(input ?? []);
    if (!files.length || busy) return;
    setBusy(true);
    try {
      const result = await uploadMoves(files, options, {
        getDb,
        commit,
        readFile,
        ai: isServer() && !!getUser()?.integrations?.ai,
        digitize: (body) => serverAction('/api/integrations/digitize', body),
      });
      if (result.errors.length) alert(result.errors.map(translateUploadError).join('\n'));
      if (result.go) location.hash = result.go;
    } catch (error) { alert(translateUploadError(error.message)); } finally { setBusy(false); }
  };
  return { upload, busy };
}

export function UploadButton({ upload, busy, className = 'btn' }) {
  return <label className={className}><span>{t('Upload')}</span><input type="file" multiple hidden disabled={busy} onChange={(e) => { upload(e.target.files); e.target.value = ''; }} /></label>;
}
