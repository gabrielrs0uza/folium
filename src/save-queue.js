// Keep writes ordered. A failed write must not poison later attempts or be
// mistaken for a successful save when the user closes the window.
export function createSaveQueue(write) {
  let tail = Promise.resolve();
  let latest;
  let failure = null;
  return {
    save(data) {
      latest = JSON.parse(JSON.stringify(data));
      const snapshot = latest;
      const result = tail.then(() => write(snapshot));
      tail = result.then(() => { failure = null; }, error => { failure = error; });
      return result;
    },
    async flush() {
      await tail;
      if (failure) {
        await write(latest);
        failure = null;
      }
    },
  };
}
