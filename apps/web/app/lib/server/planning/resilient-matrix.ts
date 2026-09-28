import { ProviderError, type ProviderRequestOptions, type TravelTimeMatrixPort, type TravelTimeMatrixRequest } from "@mmi/provider-contracts";

export class ResilientMatrixAdapter implements TravelTimeMatrixPort {
  readonly warnings: string[] = [];
  private primaryDisabled = false;

  constructor(private readonly primary: TravelTimeMatrixPort, private readonly fallback: TravelTimeMatrixPort) {}

  get providerId() { return this.primaryDisabled ? this.fallback.providerId : this.primary.providerId; }

  async calculate(request: TravelTimeMatrixRequest, options: ProviderRequestOptions = {}) {
    if (!this.primaryDisabled) {
      try {
        return await this.primary.calculate(request, options);
      } catch (error) {
        if (!(error instanceof ProviderError) || error.code === "CANCELLED") throw error;
        this.primaryDisabled = true;
        this.warnings.push(`${error.message} Для текущего расчёта использована локальная оценочная матрица без дорожного графа и пробок.`);
      }
    }
    return this.fallback.calculate(request, options);
  }
}
