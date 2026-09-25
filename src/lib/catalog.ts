import type { Category, ConditionCode, GradingCompany } from "./types";

export const APP_NAME = "Holo";

export const CATEGORIES: Category[] = [
  { slug: "pokemon", name: "Pokémon", kind: "tcg" },
  { slug: "nba", name: "NBA", kind: "sports" },
  { slug: "nfl", name: "NFL", kind: "sports" },
];

export function categoryName(slug: string): string {
  return CATEGORIES.find((c) => c.slug === slug)?.name ?? slug;
}

export const CONDITIONS: { code: ConditionCode; label: string; hint: string }[] = [
  { code: "NM", label: "Near Mint", hint: "Como nueva, a lo sumo detalles mínimos" },
  { code: "LP", label: "Lightly Played", hint: "Desgaste leve en bordes o esquinas" },
  { code: "MP", label: "Moderately Played", hint: "Desgaste visible, sin dobleces" },
  { code: "HP", label: "Heavily Played", hint: "Desgaste fuerte, marcas o rayones" },
  { code: "DMG", label: "Dañada", hint: "Dobleces, roturas o manchas" },
];

export const GRADING_COMPANIES: GradingCompany[] = ["PSA", "BGS", "CGC", "SGC", "TAG"];

/** Neighborhood-level locations. Deliberately coarse to protect sellers. */
export const LOCATIONS: { province: string; district: string; neighborhoods: string[] }[] = [
  {
    province: "Panamá",
    district: "Panamá",
    neighborhoods: [
      "Bella Vista", "Brisas del Golf", "Clayton", "Condado del Rey", "Costa del Este",
      "El Cangrejo", "Obarrio", "Punta Pacífica", "San Francisco", "Tumba Muerto",
      "Villa de las Fuentes", "Albrook", "Juan Díaz", "Pedregal",
    ],
  },
  { province: "Panamá", district: "San Miguelito", neighborhoods: ["Los Andes", "Villa Lucre", "Cerro Viento"] },
  { province: "Panamá Oeste", district: "Arraiján", neighborhoods: ["Vista Alegre", "Costa Verde", "Nuevo Chorrillo"] },
  { province: "Panamá Oeste", district: "La Chorrera", neighborhoods: ["Centro", "Guadalupe"] },
  { province: "Colón", district: "Colón", neighborhoods: ["Centro", "Sabanitas"] },
  { province: "Chiriquí", district: "David", neighborhoods: ["Centro", "San Mateo"] },
  { province: "Veraguas", district: "Santiago", neighborhoods: ["Centro"] },
  { province: "Herrera", district: "Chitré", neighborhoods: ["Centro"] },
  { province: "Coclé", district: "Penonomé", neighborhoods: ["Centro"] },
];

export const PROVINCES = [...new Set(LOCATIONS.map((l) => l.province))];
