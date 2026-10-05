import { useId, useState } from 'react';
import { ArrowRight, Eye, EyeOff, GitFork, LoaderCircle, LockKeyhole } from 'lucide-react';
import { Button } from '../ui/Button.jsx';
import { Input } from '../ui/Input.jsx';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../ui/Card.jsx';

export function OwnerConnection({ authenticate, notification }) {
  const [credential, setCredential] = useState('');
  const [pending, setPending] = useState(false);
  const [showCredential, setShowCredential] = useState(false);
  const credentialId = useId();
  const helpId = `${credentialId}-help`;
  const feedbackId = `${credentialId}-feedback`;

  async function connect(event) {
    event.preventDefault();
    if (pending || !credential) return;
    setPending(true);
    try {
      if (await authenticate(credential)) setCredential('');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="connection-screen dark">
      <div className="connection-shell">
        <div className="connection-brand">
          <span className="connection-brand-mark">
            <GitFork size={22} aria-hidden="true" />
          </span>
          <span>klocgit</span>
        </div>
        <Card className="connection-card">
          <CardHeader className="connection-header">
            <CardTitle>
              <h1>Connect to your workspace</h1>
            </CardTitle>
            <CardDescription>
              Authenticate with your owner credential to inspect work and resolve decisions.
            </CardDescription>
          </CardHeader>
          <CardContent className="connection-content">
            <form className="auth-form" onSubmit={connect} aria-busy={pending}>
              <div className="credential-field">
                <label htmlFor={credentialId}>Owner credential</label>
                <div className="credential-control">
                  <Input
                    id={credentialId}
                    className="connection-input"
                    type={showCredential ? 'text' : 'password'}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={credential}
                    onChange={(event) => setCredential(event.target.value)}
                    aria-describedby={notification ? `${helpId} ${feedbackId}` : helpId}
                    disabled={pending}
                    required
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="credential-visibility"
                    onClick={() => setShowCredential((shown) => !shown)}
                    aria-label={showCredential ? 'Hide owner credential' : 'Show owner credential'}
                    aria-pressed={showCredential}
                    disabled={pending}
                  >
                    {showCredential ? (
                      <EyeOff size={16} aria-hidden="true" />
                    ) : (
                      <Eye size={16} aria-hidden="true" />
                    )}
                  </Button>
                </div>
              </div>
              {notification && (
                <p id={feedbackId} className="connection-feedback" role="alert">
                  {notification.text}
                </p>
              )}
              <Button type="submit" className="connection-submit" disabled={pending || !credential}>
                {pending ? (
                  <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                ) : (
                  <ArrowRight size={16} aria-hidden="true" />
                )}
                {pending ? 'Connecting…' : 'Connect to workspace'}
              </Button>
            </form>
          </CardContent>
          <CardFooter className="connection-footer">
            <LockKeyhole size={14} aria-hidden="true" />
            <p id={helpId}>The credential stays in this page’s memory.</p>
          </CardFooter>
        </Card>
      </div>
    </main>
  );
}
