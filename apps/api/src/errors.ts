export class HttpProblem extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpProblem";
    this.status = status;
    this.code = code;
  }
}

export class NotFound extends HttpProblem {
  constructor(what: string) { super(404, "not_found", `${what} not found`); }
}

export class Invalid extends HttpProblem {
  constructor(message: string) { super(400, "invalid", message); }
}

export class Unauthorized extends HttpProblem {
  constructor(message = "missing or invalid API key") { super(401, "unauthorized", message); }
}

export class Forbidden extends HttpProblem {
  constructor(message = "the key does not carry this scope") { super(403, "forbidden", message); }
}
