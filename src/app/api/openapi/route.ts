export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return Response.json({
    openapi: "3.1.0",
    info: { title: "AIbanking Controlled Agent API", version: "0.2.0", description: "User-scoped banking API. Write operations create drafts; final transfer authorization is bank-app only." },
    servers: [{ url: origin }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "bpt" } } },
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/v1/transfers/prepare": { post: { summary: "Prepare, but never execute, a transfer", responses: { "201": { description: "Draft requiring authorization in the bank app" } } } },
      "/api/v1/operations/{operationId}": { get: { summary: "Read an operation owned by this user", parameters: [{ name: "operationId", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Operation status" } } } },
    },
  });
}
