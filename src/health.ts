export class HealthState {
  alive = true;
  configValid = false;
  dbHealthy = false;
  schemaValid = false;
  lockHeld = false;
  recoveryCompleted = false;
  processorActive = false;
  ingressOpen = false;
  failure: string | null = null;
  instanceId = "";

  get ready(): boolean {
    return (
      this.alive &&
      this.configValid &&
      this.dbHealthy &&
      this.schemaValid &&
      this.lockHeld &&
      this.recoveryCompleted &&
      this.processorActive &&
      this.ingressOpen &&
      this.failure === null
    );
  }

  checks(): Record<string, boolean> {
    return {
      config: this.configValid,
      database: this.dbHealthy,
      schema: this.schemaValid,
      lock: this.lockHeld,
      recovery: this.recoveryCompleted,
      processor: this.processorActive,
      ingress: this.ingressOpen,
    };
  }
}
