import { useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { NativeFormDialog } from '../../ui/NativeFormDialog.jsx';
import { Button } from '../../ui/Button.jsx';
import { Input } from '../../ui/Input.jsx';
import { Textarea } from '../../ui/Textarea.jsx';
import { NativeSelect } from '../../ui/NativeSelect.jsx';
import { useNativeMutation } from '../../hooks/useNativeMutation.js';
import { apiRequest } from '../../lib/api.js';

export function ObjectiveContextDialog({
  objective,
  repositories,
  preparationId = null,
  onClose,
  onSaved,
  reload,
  message,
}) {
  const [sources, setSources] = useState([]);
  const [hypothesis, setHypothesis] = useState('');
  const [review, setReview] = useState(null);
  const [currentId, setCurrentId] = useState(preparationId);
  const [readVersion, setReadVersion] = useState(0);
  const [reading, setReading] = useState(Boolean(preparationId));
  const [readError, setReadError] = useState(null);
  const [answers, setAnswers] = useState({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [mode, setMode] = useState('answer');
  const [rationale, setRationale] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);
  const { busy, error, mutate } = useNativeMutation(reload, message);
  const working = busy || submitting || reading;
  const eligible = repositories.filter((repository) =>
    repository.status === 'ready' && repository.head && repository.tree);
  const preparation = review?.preparation;
  const questions = preparation?.questions ?? [];
  const question = questions[questionIndex];
  const current = review?.validity?.status === 'current';

  useEffect(() => {
    if (!currentId) return;
    const controller = new AbortController();
    setReading(true);
    apiRequest('/context/' + encodeURIComponent(currentId), { signal: controller.signal }).then(
      (result) => {
        if (controller.signal.aborted) return;
        setReview(result);
        setSources(result.preparation.sources.map(({ repo_id, path, ref }) => ({ repo_id, path, ref })));
        setHypothesis(result.preparation.hypothesis?.label ?? '');
        setReadError(null);
        setReading(false);
      },
      (failure) => {
        if (controller.signal.aborted) return;
        setReadError(failure.message);
        setReading(false);
      },
    );
    return () => controller.abort();
  }, [currentId, readVersion]);

  function changeSource(index, fields) {
    setSources((values) => values.map((value, position) =>
      position === index ? { ...value, ...fields } : value));
  }

  function resetAnswers() {
    setAnswers({});
    setQuestionIndex(0);
    setRationale('');
    setMode('answer');
  }

  async function prepare() {
    const result = await mutate(
      '/objectives/' + encodeURIComponent(objective.id) + '/context',
      {
        sources: sources.map(({ repo_id, path, ref }) => ({
          repo_id, path: path.trim(), ...(ref ? { ref } : {}),
        })),
        ...(hypothesis.trim() ? { hypothesis: hypothesis.trim() } : {}),
      },
      'Context retrieved.',
    );
    if (!result) return;
    resetAnswers();
    setReview({ ...result, validity: { status: 'current', reasons: [] } });
    setCurrentId(result.preparation.id);
    setReadError(null);
  }

  async function submit(event) {
    event.preventDefault();
    if (working || pending.current) return;
    if (preparation && !review.snapshot && current && question &&
        questionIndex < questions.length - 1) {
      if (answers[question.id]) setQuestionIndex((index) => index + 1);
      return;
    }
    pending.current = true;
    setSubmitting(true);
    try {
      if (!preparation) {
        await prepare();
        return;
      }
      if (!current) return;
      if (review.snapshot) {
        onSaved({ objective, preparation, snapshot: review.snapshot });
        return;
      }
      const result = await mutate(
        '/context/' + encodeURIComponent(preparation.id) + '/resolve',
        {
          expected_basis_hash: preparation.basis_hash,
          mode, answers, ...(rationale.trim() ? { rationale: rationale.trim() } : {}),
        },
        mode === 'assumption' ? 'Assumptions recorded.' : 'Answers recorded.',
      );
      if (result) {
        setReview({ ...result, validity: { status: 'current', reasons: [] } });
        onSaved({ objective, preparation: result.preparation, snapshot: result.snapshot });
      } else {
        // Failed CAS never reapplies the old answer to a new context basis.
        resetAnswers();
        setReadVersion((value) => value + 1);
      }
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }

  async function refreshContext() {
    if (working || pending.current) return;
    pending.current = true;
    setSubmitting(true);
    try { await prepare(); }
    finally {
      pending.current = false;
      setSubmitting(false);
    }
  }

  const sourceInputsValid = sources.every((source) =>
    source.path.trim() && eligible.some((repository) => repository.id === source.repo_id));
  const lastQuestion = questionIndex === questions.length - 1;
  const answersComplete = questions.every((entry) => answers[entry.id]);
  const disabled = Boolean(readError) || (preparation
    ? !current || (!review.snapshot &&
      (!question || !answers[question.id] ||
        (lastQuestion && (!answersComplete || (mode === 'assumption' && !rationale.trim())))))
    : !sourceInputsValid);
  const submitLabel = !preparation
    ? 'Retrieve context'
    : review.snapshot
      ? 'Use this context'
      : !lastQuestion
        ? 'Next question'
        : mode === 'assumption'
          ? 'Record assumptions'
          : 'Record answers';

  return (
    <NativeFormDialog
      title="Context before work"
      description={objective.statement || 'Retrieve relevant constraints and previous decisions before forking.'}
      onClose={onClose}
      onSubmit={submit}
      busy={working}
      error={error || readError}
      disabled={disabled}
      submitLabel={submitLabel}
      pendingLabel={reading ? 'Reading context…' : 'Saving…'}
    >
      {!preparation && !reading && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Existing constraints and decisions are included. Add repository files when they contain relevant context.
          </p>
          {sources.map((source, index) => (
            <section key={index} className="space-y-3 rounded-md border p-3">
              <label className="grid gap-2 text-sm">
                Repository for source {index + 1}
                <NativeSelect
                  aria-label={'Repository for source ' + (index + 1)}
                  value={source.repo_id}
                  onChange={(event) => changeSource(index, { repo_id: event.target.value, ref: undefined })}
                >
                  <option value="">Choose repository</option>
                  {eligible.map((repository) => (
                    <option key={repository.id} value={repository.id}>{repository.id}</option>
                  ))}
                </NativeSelect>
              </label>
              <label className="grid gap-2 text-sm">
                Path for source {index + 1}
                <Input
                  value={source.path}
                  onChange={(event) => changeSource(index, { path: event.target.value })}
                  maxLength={500}
                  required
                />
              </label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setSources((values) => values.filter((_, position) => position !== index))}
                aria-label={'Remove source ' + (index + 1)}
              >
                <Trash2 aria-hidden="true" /> Remove
              </Button>
            </section>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={sources.length >= 20 || !eligible.length}
            onClick={() => setSources((values) => [...values, { repo_id: '', path: '' }])}
          >
            <Plus aria-hidden="true" /> Add context file
          </Button>
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">Compare an alternative approach</summary>
            <label className="mt-3 grid gap-2 text-sm">
              Approach name (optional)
              <Input value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} maxLength={100} />
            </label>
          </details>
          <p className="text-xs leading-6 text-muted-foreground">
            Files are read at exact Git commits. Raw file content stays in Git.
          </p>
        </div>
      )}
      {reading && !preparation && (
        <p role="status" className="text-sm text-muted-foreground">Reading the saved context…</p>
      )}
      {preparation && (
        <div className="space-y-5">
          {!current && (
            <div className="space-y-3">
              <p role="alert" className="text-sm">
                Context changed. Retrieve the new basis and review it before answering.
              </p>
              {review.validity?.reasons.map((reason) => (
                <p key={reason} className="text-xs text-muted-foreground">{reason}</p>
              ))}
              <Button type="button" variant="outline" onClick={refreshContext} disabled={working}>
                <RefreshCw aria-hidden="true" /> Refresh context
              </Button>
            </div>
          )}
          <section className="space-y-3" aria-label="Retrieved context">
            <h2 className="text-sm font-medium">Retrieved constraints and decisions</h2>
            {preparation.items.filter((item) => item.type === 'constraint' || item.type === 'decision').map((item) => (
              <div key={item.id} className="space-y-2 rounded-md border p-3">
                <p className="text-xs text-muted-foreground">{item.type} · {item.basis}</p>
                <p className="text-sm">{item.value.statement || item.value.rationale}</p>
                {item.value.application_state && (
                  <p className="text-xs text-muted-foreground">Application: {item.value.application_state}</p>
                )}
              </div>
            ))}
            {!preparation.items.some((item) => item.type === 'constraint' || item.type === 'decision') && (
              <p className="text-sm text-muted-foreground">No scoped constraints or previous decisions were retrieved.</p>
            )}
          </section>
          {!review.snapshot && question && current && (
            <section className="space-y-4" aria-label="Material clarification">
              <p className="text-xs text-muted-foreground">
                Question {questionIndex + 1} of {questions.length} · inferred from declared option effects
              </p>
              <label className="grid gap-2 text-sm font-medium">
                {question.question}
                <NativeSelect
                  aria-label={question.question}
                  value={answers[question.id] ?? ''}
                  onChange={(event) => setAnswers((values) => ({ ...values, [question.id]: event.target.value }))}
                >
                  <option value="">Choose an option</option>
                  {question.options.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </NativeSelect>
              </label>
              {question.options.map((option) => (
                <div key={option.id} className="space-y-1 text-xs text-muted-foreground">
                  <p className="font-medium">{option.label}</p>
                  {option.effects.map((effect) => <p key={effect}>{effect}</p>)}
                </div>
              ))}
              {questionIndex > 0 && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setQuestionIndex((index) => index - 1)}>
                  Previous question
                </Button>
              )}
              {lastQuestion && (
                <>
                  <label className="grid gap-2 text-sm">
                    Record as
                    <NativeSelect aria-label="Record as" value={mode} onChange={(event) => setMode(event.target.value)}>
                      <option value="answer">Declared answer</option>
                      <option value="assumption">Unconfirmed assumption</option>
                    </NativeSelect>
                  </label>
                  <label className="grid gap-2 text-sm">
                    {mode === 'assumption' ? 'Why proceed under this assumption?' : 'Rationale (optional)'}
                    <Textarea
                      value={rationale}
                      onChange={(event) => setRationale(event.target.value)}
                      maxLength={2000}
                      rows={3}
                      required={mode === 'assumption'}
                    />
                  </label>
                  <p className="text-xs leading-6 text-muted-foreground">
                    Assumptions stay unresolved and require human judgment. Other producers can work without this context.
                  </p>
                </>
              )}
            </section>
          )}
          {review.snapshot && (
            <section className="space-y-3" aria-label="Recorded context">
              <h2 className="text-sm font-medium">Context recorded</h2>
              {review.snapshot.resolutions.map((resolution) => (
                <p key={resolution.id} className="text-sm">
                  {resolution.value.key}: {resolution.value.option_id} · {resolution.type} · {resolution.basis}
                </p>
              ))}
              {!review.snapshot.resolutions.length && (
                <p className="text-sm text-muted-foreground">No annotated material ambiguity was found.</p>
              )}
              <p className="text-xs leading-6 text-muted-foreground">
                This snapshot follows the Future revision, selected Git material and the eventual decision.
              </p>
            </section>
          )}
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">Exact source versions</summary>
            <div className="mt-3 space-y-3 break-all text-xs text-muted-foreground">
              {preparation.sources.map((source) => (
                <dl key={source.id} className="space-y-1">
                  <dt>{source.repo_id}/{source.path}</dt>
                  <dd>Commit: {source.commit}</dd>
                  <dd>Tree: {source.tree}</dd>
                </dl>
              ))}
              <p>Preparation: {preparation.id}</p>
              {review.snapshot && <p>Snapshot: {review.snapshot.id}</p>}
            </div>
          </details>
        </div>
      )}
    </NativeFormDialog>
  );
}
