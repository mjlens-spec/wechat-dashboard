import { NextRequest, NextResponse } from 'next/server';

function isLoopback(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized.startsWith('127.')
  );
}

export function proxy(request: NextRequest) {
  if (!isLoopback(request.nextUrl.hostname)) {
    return new NextResponse('WeChat Dashboard only accepts local requests.', { status: 403 });
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const origin = request.headers.get('origin');
    if (!origin) {
      return new NextResponse('Write requests require a same-origin browser context.', {
        status: 403,
      });
    }
    try {
      const originUrl = new URL(origin);
      const requestHost = request.headers.get('host')?.toLowerCase();
      if (
        !requestHost ||
        !isLoopback(originUrl.hostname) ||
        originUrl.host.toLowerCase() !== requestHost
      ) {
        return new NextResponse('Cross-origin writes are blocked.', { status: 403 });
      }
    } catch {
      return new NextResponse('Invalid request origin.', { status: 403 });
    }
  }

  const response = NextResponse.next();
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.headers.set(
    'Content-Security-Policy',
    "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  );
  if (request.nextUrl.pathname.startsWith('/api/')) {
    response.headers.set('Cache-Control', 'no-store, max-age=0');
    response.headers.set('Pragma', 'no-cache');
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
