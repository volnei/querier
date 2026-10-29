export class NoRowsError extends Error {
  override readonly name = "NoRowsError";

  constructor() {
    super("Expected one row, but the query returned none");
  }
}

export class TooManyRowsError extends Error {
  override readonly name = "TooManyRowsError";

  constructor(readonly rowCount: number) {
    super(`Expected at most one row, but the query returned ${rowCount}`);
  }
}

export class TransactionClosedError extends Error {
  override readonly name = "TransactionClosedError";

  constructor() {
    super("Cannot execute a query after its transaction callback has completed");
  }
}

export class RowValidationError extends Error {
  override readonly name = "RowValidationError";

  constructor(
    readonly rowIndex: number,
    override readonly cause: unknown,
  ) {
    super(`Query result row ${rowIndex} did not match its schema`, { cause });
  }
}
