/**
 * Typed errors. Each carries an HTTP status and a machine-readable `code`
 * so the frontend can branch on the cause (especially VERSION_CONFLICT,
 * which drives the "someone changed this, reload" banner) rather than
 * pattern-matching on message text.
 */
export class AppError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL', details = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = status < 500;
  }
}

export class ValidationError extends AppError {
  constructor(message, details) {
    super(message, { status: 422, code: 'VALIDATION_FAILED', details });
  }
}

export class NotFoundError extends AppError {
  constructor(what, id) {
    super(`${what} not found`, { status: 404, code: 'NOT_FOUND', details: { what, id } });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do that.', details) {
    super(message, { status: 403, code: 'FORBIDDEN', details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Sign in to continue.') {
    super(message, { status: 401, code: 'UNAUTHORIZED' });
  }
}

export class ConflictError extends AppError {
  constructor(message, details) {
    super(message, { status: 409, code: details?.code ?? 'CONFLICT', details });
  }
}

export class ConsentRequiredError extends AppError {
  constructor(message = 'Face grouping needs your explicit consent for this trip first.') {
    super(message, { status: 451, code: 'CONSENT_REQUIRED' });
  }
}
