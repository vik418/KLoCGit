let ownerCredential = '';

export function setOwnerCredential(credential) {
  ownerCredential = credential;
}

export async function apiRequest(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(ownerCredential ? { Authorization: `Bearer ${ownerCredential}` } : {}),
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const responseData = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(responseData.message), responseData);
  }
  return responseData;
}
