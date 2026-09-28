type MaterialIconProps = {
  name: string;
  className?: string;
  filled?: boolean;
};

export default function MaterialIcon({ name, className = "", filled = false }: MaterialIconProps) {
  const classes = ["material-symbols-outlined", filled ? "material-icon-filled" : "", className]
    .filter(Boolean)
    .join(" ");

  return <span className={classes} aria-hidden="true">{name}</span>;
}
