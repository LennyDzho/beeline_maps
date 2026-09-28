/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    const response = await handler.fetch(request, env, ctx);
    const contentType = response.headers.get("Content-Type") ?? "";
    const sessionDependent = url.pathname.startsWith("/api/")
      || response.headers.has("Set-Cookie")
      || (response.status >= 300 && response.status < 400)
      || contentType.includes("text/html")
      || contentType.includes("text/x-component");
    if (!sessionDependent) return response;

    // Authentication redirects bypass the framework's force-dynamic page headers.
    // Apply this at the response boundary, including redirects and RSC responses,
    // without disabling caching of static JS, CSS, fonts or map assets.
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-cache, no-store, max-age=0, must-revalidate");
    const vary = (headers.get("Vary") ?? "").split(",").map((value) => value.trim().toLowerCase());
    if (!vary.includes("cookie") && !vary.includes("*")) headers.append("Vary", "Cookie");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};

export default worker;
