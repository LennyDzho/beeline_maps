---
name: Маршрут Design System
colors:
  surface: '#fdf7ff'
  surface-dim: '#ded8e0'
  surface-bright: '#fdf7ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f8f2fa'
  surface-container: '#f2ecf4'
  surface-container-high: '#ece6ee'
  surface-container-highest: '#e6e0e9'
  on-surface: '#1d1b20'
  on-surface-variant: '#494551'
  inverse-surface: '#322f35'
  inverse-on-surface: '#f5eff7'
  outline: '#7a7582'
  outline-variant: '#cbc4d2'
  surface-tint: '#6750a4'
  primary: '#4f378a'
  on-primary: '#ffffff'
  primary-container: '#6750a4'
  on-primary-container: '#e0d2ff'
  inverse-primary: '#cfbcff'
  secondary: '#63597c'
  on-secondary: '#ffffff'
  secondary-container: '#e1d4fd'
  on-secondary-container: '#645a7d'
  tertiary: '#765b00'
  on-tertiary: '#ffffff'
  tertiary-container: '#c9a74d'
  on-tertiary-container: '#503d00'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e9ddff'
  primary-fixed-dim: '#cfbcff'
  on-primary-fixed: '#22005d'
  on-primary-fixed-variant: '#4f378a'
  secondary-fixed: '#e9ddff'
  secondary-fixed-dim: '#cdc0e9'
  on-secondary-fixed: '#1f1635'
  on-secondary-fixed-variant: '#4b4263'
  tertiary-fixed: '#ffdf93'
  tertiary-fixed-dim: '#e7c365'
  on-tertiary-fixed: '#241a00'
  on-tertiary-fixed-variant: '#594400'
  background: '#fdf7ff'
  on-background: '#1d1b20'
  surface-variant: '#e6e0e9'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.05em
  headline-sm-mobile:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  gutter: 16px
  margin-mobile: 16px
  margin-desktop: 32px
---

## Brand & Style

The design system is built for a Field Service Management (FSM) environment where precision and reliability are paramount. The visual language balances a professional, industrial-strength utility with a calm, human-centric interface. 

The style is **Corporate Modern** with a focus on high legibility and structured information density. It utilizes a restrained color palette dominated by deep forest tones to evoke stability, complemented by warm gold accents that guide the user's eye to critical actions without creating visual fatigue. The interface favors clarity over decoration, using subtle depth and soft geometry to organize complex logistical data.

**Target Audience:**
- **Dispatchers (Desktop):** Requiring high-density data tables and expansive map views.
- **Field Engineers (Mobile):** Requiring high-contrast touch targets and glanceable status updates.

## Colors

The palette is anchored by "Dark Forest," used primarily for navigation and branding to establish a sense of authority. 

- **Primary Action:** Use `#174A3A` for high-priority buttons and active states.
- **Accents:** Use `#F2C56B` sparingly for highlights, warnings, or "pending" states to ensure visibility against the deep greens.
- **Semantic Routes:** The specific route colors (Orange, Blue, Green) must maintain a minimum 4.5:1 contrast ratio against white surfaces for accessibility on maps and charts.
- **Neutral Scales:** The background `#F3F5F4` provides a soft, low-glare canvas for long-duration usage, while `#E3E8EA` serves as the standard for hair-line dividers and input strokes.

## Typography

The design system utilizes **Inter** for its exceptional Cyrillic legibility and neutral, technical character. 

- **Body Text:** Use `body-lg` (16px) for long-form content and `body-md` (14px) for data-heavy tables and sidebars to maximize information density.
- **Hierarchy:** Headlines should use a tighter letter spacing and heavier weights to stand out against the functional body text.
- **Labels:** Small caps or increased letter spacing should be applied to `label-md` for metadata headers and table columns.
- **Numeric Data:** For coordinates, timestamps, and IDs, ensure the use of tabular num features (tnum) if available to maintain vertical alignment in lists.

## Layout & Spacing

The design system follows a strict **8px grid** (with a 4px sub-grid for icons and tight components).

- **Desktop Layout:** Utilizes a fixed left sidebar (240px-280px) in `primary_dark_forest`. The main content area uses a fluid grid with a maximum container width of 1440px for data tables.
- **Mobile Layout:** Adheres to a 4-column fluid grid with 16px side margins. Key actions are housed in a fixed bottom navigation bar or a sticky FAB (Floating Action Button).
- **Density:** Provide "Comfortable" and "Compact" views for tables. Compact views reduce vertical padding from 12px to 8px.

## Elevation & Depth

Hierarchy is established through **Tonal Layering** and soft, natural shadows.

- **Level 0 (Background):** `#F3F5F4` – The base canvas.
- **Level 1 (Surface):** `#FFFFFF` – Cards, table rows, and content containers. Use a very subtle 1px border (`#E3E8EA`) instead of shadows for flat elements.
- **Level 2 (Raised):** Used for Route Cards and hover states. Shadow: `0px 4px 12px rgba(23, 35, 45, 0.08)`.
- **Level 3 (Overlay):** Used for Modals, Drawers, and Popovers. Shadow: `0px 12px 32px rgba(23, 35, 45, 0.12)`.
- **Interactive States:** On hover, white surfaces should transition to a slightly darker tint or gain a soft shadow to indicate interactability.

## Shapes

The shape language is **Rounded**, using a 10px to 12px corner radius to soften the technical nature of the application.

- **Standard Elements:** Buttons, Input Fields, and Cards use `rounded-lg` (10px).
- **Small Elements:** Checkboxes, Tags, and Status Badges use `rounded-sm` (4px).
- **Large Elements:** Modals and Bottom Sheets use `rounded-xl` (16px to 24px on top corners) to emphasize their role as containers.
- **Icons:** Use 24px bounding boxes with a 2px stroke weight. Avoid filled icons unless indicating an "active" state in navigation.

## Components

### Data Tables
- **Header:** Sticky headers with `label-md` typography and `#E3E8EA` bottom border.
- **Rows:** Alternating zebra stripes are optional; preference is for 1px separators. Hover state: `#F9FAFA`.
- **Badges:** Status indicators use a background tint (15% opacity of the semantic color) + solid text + a 12px leading icon.

### Cards (Route & Visit)
- **Route Cards:** Feature a thick 4px left-border accent using the `route_color` tokens. Include a "Time Window" indicator in the top right.
- **Visit Cards:** Interactive cards for mobile with large touch targets (min 48px height). Primary info in `text_primary`, secondary metadata in `text_secondary`.

### Map Elements
- **Pins:** Custom pins using `primary_action_green` for the active task and `text_secondary` for completed tasks. Ensure a white halo around pins for visibility on satellite layers.

### Forms & Inputs
- **Inputs:** 1px `#E3E8EA` border. On focus, transition to `primary_action_green` border with a 2px outer glow.
- **Buttons:**
    - **Primary:** Forest green background, white text.
    - **Secondary:** White background, forest green border.
    - **Accent:** Gold background for "Emergency" or "High Priority" reassignment.

### Navigation
- **Sidebar (Desktop):** Collapsible; icons only in collapsed state. Active state indicated by a gold vertical bar on the left edge.
- **Bottom Nav (Mobile):** 4-5 items maximum. Active item uses `primary_action_green`.