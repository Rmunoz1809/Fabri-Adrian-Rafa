/** Yappy error codes mapped to messages for the buyer. */
export const YAPPY_ERRORS: Record<string, string> = {
  E005: "Ese número no está registrado en Yappy. Revisa el celular o usa otro con Yappy activo.",
  E007: "Esta orden ya se registró en Yappy. Vuelve a intentar la compra para generar una nueva.",
  E009: "No pudimos generar la orden (código de orden inválido). Inténtalo de nuevo.",
  E010: "Los montos de la orden no son válidos. Inténtalo de nuevo o escríbenos.",
  E011: "Hubo un error de configuración con Yappy. Ya nos avisaron; inténtalo más tarde.",
  E100: "Yappy rechazó la solicitud. Inténtalo de nuevo en unos minutos.",
};

export const YAPPY_GENERIC_ERROR = "No pudimos conectar con Yappy. Inténtalo de nuevo en unos minutos.";

export function yappyErrorMessage(code: string | undefined): string {
  return (code && YAPPY_ERRORS[code]) || YAPPY_GENERIC_ERROR;
}
