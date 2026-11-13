// What a consultation is doing right now, kept only for the live view. Command output can hold
// anything, so it stays out of the database.
// ponytail: in-memory, so a restart empties it and it assumes one backend; the tool_calls log is the record.
const MAX_ENTRIES = 500;
const MAX_CONSULTATIONS = 20;

const streams = new Map();
let lastSeq = 0;

export function pushStream(consultationId, kind, text) {
  let entries = streams.get(consultationId);
  if (!entries) {
    entries = [];
    streams.set(consultationId, entries);
    if (streams.size > MAX_CONSULTATIONS) streams.delete(streams.keys().next().value);
  }
  const entry = { seq: ++lastSeq, kind, text };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  return entry;
}

export const streamOf = (consultationId) => streams.get(consultationId) ?? [];
