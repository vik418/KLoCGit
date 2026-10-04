export function ErrorMessage({ error }) {
  return error ? (
    <p className="error-banner" role="alert">
      {error}
    </p>
  ) : null;
}
