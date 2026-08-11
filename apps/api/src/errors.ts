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
