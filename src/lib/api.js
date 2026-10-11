let ownerCredential = '';

export function setOwnerCredential(credential) {
  ownerCredential = credential;
}

export async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  if (ownerCredential) headers.set('Authorization', `Bearer ${ownerCredential}`);
  const response = await fetch(`/api${path}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const responseData = await response.json();
  if (!response.ok) {
    const failure = responseData.error;
    throw Object.assign(new Error(responseData.message ?? failure?.message), responseData, {
      code: failure?.code ?? responseData.error,
    });
  }
  return responseData;
}
