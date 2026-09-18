/** Desktop ROOM Kg: list entries precede the legacy single dialog; only entry zero is consumed. */
export function readDesktopConversationRisk(settingExt?: Readonly<Record<string, string>>): unknown {
  const single = settingExt?.['a:sky_eye_dialog'];
  const list = settingExt?.['a:sky_eye_dialog_list'];
  if (!(single || (list && list !== '[]'))) return undefined;
  const entries: Iterable<unknown> = list ? JSON.parse(list) : [];
  const dialog: unknown = single ? JSON.parse(single) : undefined;
  // Preserve the source parsing/spread order and errors: malformed state must not silently allow a send.
  const dialogs = [...entries];
  if (dialog) dialogs.push(dialog);
  return dialogs[0];
}

/** ROOM's !isEmpty(Kg(...)), restricted to values produced by JSON.parse / string iteration. */
export function hasDesktopConversationRisk(settingExt?: Readonly<Record<string, string>>): boolean {
  const dialog = readDesktopConversationRisk(settingExt);
  if (typeof dialog === 'string' || Array.isArray(dialog)) return dialog.length > 0;
  return dialog !== null && typeof dialog === 'object' && Object.keys(dialog).length > 0;
}
