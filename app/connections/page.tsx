import {chatGPTSignInPath} from '@/app/chatgpt-auth';
import {getBindings} from '@/db';
import {McpConnectionPage} from '@/app/features/workflow/pages/mcp-connection-page';

export const dynamic = 'force-dynamic';
export default async function ConnectionsPage({searchParams}: {searchParams: Promise<{returnTo?: string}>}) {
  const input = (await searchParams)?.returnTo;
  let returnHref = '/?view=simple';
  if (typeof input === 'string' && input.startsWith('/') && !input.startsWith('//')) {
    const url = new URL(input, 'https://app.local');
    if (url.origin === 'https://app.local' && url.pathname === '/') returnHref = url.pathname + url.search;
  }
  const returnPath = `/connections?returnTo=${encodeURIComponent(returnHref)}`;
  return <McpConnectionPage returnHref={returnHref} loginHref={chatGPTSignInPath(returnPath)} localPreview={getBindings().APP_ENV === 'local'} />;
}
