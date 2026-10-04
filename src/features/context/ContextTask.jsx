import { useState } from 'react';
import { Badge } from '../../ui/Badge.jsx';
import { apiRequest } from '../../lib/api.js';
import { shortId } from '../../lib/format.js';

export function ContextTask({ task, local, reload, message }) {
  const [answer, setAnswer] = useState(null),
    [busy, setBusy] = useState(false);
  async function start() {
    setBusy(true);
    try {
      if (!task.authorization)
        await apiRequest('/tasks/' + task.task.id + '/answer', {
          method: 'POST',
          body: { value: answer },
        });
      if (local) await apiRequest('/demo/start', { method: 'POST' });
      await reload();
      message(
        local
          ? 'Context recorded. Concurrent Git work has been ingested and analyzed.'
          : 'Context recorded. Producers can now begin work.',
      );
    } catch (e) {
      await reload();
      message(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="context-task">
      <Badge tone="blue">Context before code</Badge>
      <h2>
        {task.authorization ? 'Context is ready for producers.' : 'One choice before work begins'}
      </h2>
      <p>{task.task.statement}</p>
      <blockquote>{task.constraint.value.statement}</blockquote>
      <p className="context-source">
        Retrieved from {task.source.repo}/{task.source.path} ·{' '}
        <code>{shortId(task.source.commit)}</code>
      </p>
      {!task.authorization && (
        <fieldset>
          <legend>{task.question.statement}</legend>
          {task.question.options.map((o) => (
            <label key={String(o.value)}>
              <input
                type="radio"
                name="context-answer"
                checked={answer === o.value}
                onChange={() => setAnswer(o.value)}
              />
              {o.value
                ? 'Retry using the same order identity'
                : 'Do not retry; preserve an uncertain outcome'}
            </label>
          ))}
        </fieldset>
      )}
      {task.authorization && (
        <p>
          Recorded as {task.authorization.basis}. The immutable answer will travel with the proposal
          and Git commit.
        </p>
      )}
      <button
        className="button dark"
        disabled={busy || (!task.authorization && answer === null)}
        onClick={start}
      >
        {busy ? 'Running…' : local ? 'Start concurrent work' : 'Record answer'}
      </button>
    </section>
  );
}
