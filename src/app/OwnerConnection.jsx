import { useState } from 'react';
import { GitFork } from 'lucide-react';

export function OwnerConnection({ authenticate, notification }) {
  const [credential, setCredential] = useState('');

  async function connect(event) {
    event.preventDefault();
    if (await authenticate(credential)) setCredential('');
  }

  return (
    <div className="loading">
      <GitFork size={32} />
      <h2>Connect to your workspace</h2>
      <p>Use your owner credential to inspect and resolve decisions.</p>
      <form className="auth-form" onSubmit={connect}>
        <input
          type="password"
          aria-label="Owner credential"
          autoComplete="off"
          value={credential}
          onChange={(event) => setCredential(event.target.value)}
          placeholder="Owner credential"
          required
        />
        <button className="button dark">Connect</button>
      </form>
      <p>The credential stays in this page’s memory.</p>
      {notification && <p role="alert">{notification.text}</p>}
    </div>
  );
}
