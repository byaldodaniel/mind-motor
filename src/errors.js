export class MotorError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'MotorError';
    this.code = code;
  }
}
