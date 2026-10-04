import { useEffect, useRef, useState } from 'react';
import { useMutation } from '../../hooks/useMutation.js';
import { apiRequest } from '../../lib/api.js';
import { asArray, getMergeRequests, getPreparedDecisionId } from '../../lib/workspace.js';
import { getErrorReasons } from '../../lib/errors.js';

// Keep form state here so switching tabs never discards an unfinished review or comment.
export function useMergeRequestDialog({ id, workspace, onDecision, reload, message }) {
  const [loaded, setLoaded] = useState(null);
  const [tab, setTab] = useState('overview');
  const [reviewAction, setReviewAction] = useState('approve');
  const [reviewBody, setReviewBody] = useState('');
  const [comment, setComment] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [file, setFile] = useState('');
  const [line, setLine] = useState('');
  const [editTitle, setEditTitle] = useState(null);
  const [editDescription, setEditDescription] = useState(null);
  const [dependencyIds, setDependencyIds] = useState(null);
  const [checkName, setCheckName] = useState('');
  const [checkStatus, setCheckStatus] = useState('pending');
  const [checkDetails, setCheckDetails] = useState('');
  const { busy, error, mutate } = useMutation(reload, message);
  const snapshot = getMergeRequests(workspace).find((request) => request.id === id);
  const mergeRequest =
    loaded && (!snapshot || loaded.version === snapshot.version) ? loaded : snapshot;
  const firstRevision = useRef(mergeRequest?.revision_id);

  useEffect(() => {
    let alive = true;
    apiRequest('/merge-requests/' + encodeURIComponent(id))
      .then((request) => {
        if (alive) setLoaded(request.merge_request ?? request);
      })
      .catch((error) => message(error.message, 'error'));
    return () => {
      alive = false;
    };
  }, [id, workspace, message]);

  if (!mergeRequest) return { mergeRequest, busy, error };
  if (!firstRevision.current) firstRevision.current = mergeRequest.revision_id;

  const pins = {
    expected_version: mergeRequest.version,
    expected_revision_id: mergeRequest.revision_id,
  };
  const endpoint = '/merge-requests/' + id;
  const reviews = asArray(
    mergeRequest.reviews ?? workspace.reviews?.filter((review) => review.mr_id === id),
  );
  const comments = asArray(
    mergeRequest.comments ?? workspace.comments?.filter((comment) => comment.mr_id === id),
  );
  const threads = asArray(mergeRequest.threads);
  const checkRuns = asArray(
    mergeRequest.check_runs ?? workspace.checkRuns?.filter((check) => check.mr_id === id),
  );
  const selectedDependencies = dependencyIds ?? mergeRequest.dependency_ids ?? [];
  const dependencyChoices = getMergeRequests(workspace).filter(
    (request) => request.id !== id && request.status !== 'closed',
  );
  const revision = workspace.revisions.find((revision) => revision.id === mergeRequest.revision_id);
  const sourceChanged = firstRevision.current !== mergeRequest.revision_id;
  const platformEvidence = workspace.evidence
    .filter(
      (evidence) =>
        evidence.subject_ref === mergeRequest.revision_id &&
        evidence.source === 'platform-owned checks' &&
        evidence.validity?.status === 'current',
    )
    .at(-1);
  const currentApprovalCount = Array.isArray(mergeRequest.review_state?.approvals)
    ? mergeRequest.review_state.approvals.length
    : Number(mergeRequest.review_state?.approvals ?? 0);
  const missingChecks = getErrorReasons(mergeRequest.checks_state?.missing);
  const mergedDecisionId =
    mergeRequest.resolution_decision_id ??
    mergeRequest.merged_decision_id ??
    mergeRequest.merge_decision_id ??
    mergeRequest.decision_id ??
    [...workspace.decisions]
      .reverse()
      .find((decision) => decision.proposal_revision_ids?.includes(mergeRequest.revision_id))?.id;
  const mergedDecision = workspace.decisions.find((decision) => decision.id === mergedDecisionId);
  const mergedOperation = workspace.operations.find(
    (operation) => operation.decision_id === mergedDecisionId && operation.status === 'applied',
  );

  async function transition(action) {
    await mutate(
      endpoint + '/transition',
      { ...pins, action },
      action === 'ready'
        ? 'Merge request marked ready.'
        : 'Merge request ' +
            (action === 'draft'
              ? 'returned to draft'
              : action === 'close'
                ? 'closed'
                : 'reopened') +
            '.',
    );
  }

  async function prepareReview() {
    const result = await mutate(
      endpoint + '/prepare',
      { ...pins, title: mergeRequest.title },
      'Review prepared. Inspect the exact composition before applying.',
    );
    const componentId = getPreparedDecisionId(result);
    if (componentId) onDecision(componentId);
  }

  async function prepareRevert() {
    const target = mergedOperation?.target_commit ?? mergeRequest.merge_commit;
    if (!target) {
      message('The merged Git commit is unavailable.', 'error');
      return;
    }
    const result = await mutate(
      '/reverts/prepare',
      {
        repo: mergeRequest.repo,
        target_commit: target,
        ...(mergedDecisionId ? { decision_id: mergedDecisionId } : {}),
        mainline: 1,
        title: 'Review revert of merged composition',
      },
      'Revert prepared for review. Canonical Git has not changed.',
    );
    const componentId = getPreparedDecisionId(result);
    if (componentId) onDecision(componentId);
  }

  async function saveDetails(event) {
    event.preventDefault();
    const result = await mutate(
      endpoint + '/transition',
      {
        ...pins,
        action: 'update',
        title: editTitle ?? mergeRequest.title,
        description: editDescription ?? mergeRequest.description,
      },
      'Merge request details updated.',
    );
    if (result) {
      setEditTitle(null);
      setEditDescription(null);
    }
  }

  async function submitReview(event) {
    event.preventDefault();
    const result = await mutate(
      endpoint + '/reviews',
      { ...pins, action: reviewAction, body: reviewBody },
      'Review recorded for this exact revision.',
    );
    if (result) setReviewBody('');
  }

  function dismissReview(reviewId) {
    return mutate(
      endpoint + '/reviews',
      { ...pins, action: 'dismiss', review_id: reviewId },
      'Review dismissed.',
    );
  }

  async function saveDependencies() {
    const result = await mutate(
      endpoint + '/dependencies',
      { dependency_ids: selectedDependencies, expected_version: mergeRequest.version },
      'Dependencies updated. Prepare a fresh review.',
    );
    if (result) setDependencyIds(null);
  }

  async function submitComment(event) {
    event.preventDefault();
    const result = await mutate(
      endpoint + '/comments',
      {
        ...pins,
        action: 'comment',
        body: comment,
        ...(replyTo ? { thread_id: replyTo } : {}),
        ...(file ? { file, line: line ? Number(line) : undefined } : {}),
      },
      'Comment recorded for this revision.',
    );
    if (result) {
      setComment('');
      setReplyTo(null);
      setFile('');
      setLine('');
    }
  }

  function replyToThread(threadId) {
    setReplyTo(threadId);
    setFile('');
    setLine('');
  }

  function toggleThread(thread) {
    return mutate(
      endpoint + '/comments',
      { ...pins, action: thread.resolved ? 'reopen' : 'resolve', thread_id: thread.id },
      thread.resolved ? 'Discussion reopened.' : 'Discussion resolved.',
    );
  }

  async function reportCheck(event) {
    event.preventDefault();
    const result = await mutate(
      endpoint + '/checks',
      { ...pins, name: checkName, status: checkStatus, details: checkDetails },
      'Reported check recorded as a declaration.',
    );
    if (result) {
      setCheckName('');
      setCheckDetails('');
    }
  }

  function validate() {
    return mutate(
      endpoint + '/validate',
      pins,
      'Platform analysis completed for current Git inputs.',
    );
  }

  return {
    mergeRequest,
    busy,
    error,
    tab,
    setTab,
    sourceChanged,
    revision,
    reviews,
    currentApprovalCount,
    missingChecks,
    mergedDecision,
    mergedOperation,
    transition,
    prepareReview,
    prepareRevert,
    dismissReview,
    detailsForm: {
      title: editTitle ?? mergeRequest.title,
      description: editDescription ?? mergeRequest.description ?? '',
      setTitle: setEditTitle,
      setDescription: setEditDescription,
      onSubmit: saveDetails,
    },
    reviewForm: {
      action: reviewAction,
      body: reviewBody,
      setAction: setReviewAction,
      setBody: setReviewBody,
      onSubmit: submitReview,
    },
    dependencies: {
      choices: dependencyChoices,
      selected: selectedDependencies,
      setSelected: setDependencyIds,
      onSave: saveDependencies,
    },
    discussion: {
      threads,
      comments,
      onReply: replyToThread,
      onToggleThread: toggleThread,
      form: {
        comment,
        replyTo,
        file,
        line,
        setComment,
        setReplyTo,
        setFile,
        setLine,
        onSubmit: submitComment,
      },
    },
    checks: {
      runs: checkRuns,
      platformEvidence,
      onValidate: validate,
      form: {
        name: checkName,
        status: checkStatus,
        details: checkDetails,
        setName: setCheckName,
        setStatus: setCheckStatus,
        setDetails: setCheckDetails,
        onSubmit: reportCheck,
      },
    },
  };
}
