export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract override readonly message: string;

  constructor() {
    super();
    this.name = this.constructor.name;
  }

  toJSON(): { code: string; message: string } {
    return {
      code: this.code,
      message: this.message,
    };
  }
}

export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';

  constructor(readonly message: string) {
    super();
  }
}

export class ExternalServiceError extends DomainError {
  readonly code = 'EXTERNAL_SERVICE_ERROR';

  constructor(
    readonly message: string,
    readonly service: string,
  ) {
    super();
  }
}

export class TimeoutError extends DomainError {
  readonly code = 'TIMEOUT_ERROR';

  constructor(
    readonly message: string,
    readonly timeoutMs: number,
  ) {
    super();
  }
}

export class ConfigurationError extends DomainError {
  readonly code = 'CONFIGURATION_ERROR';

  constructor(readonly message: string) {
    super();
  }
}
