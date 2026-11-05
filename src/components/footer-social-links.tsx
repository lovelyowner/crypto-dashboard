import "./footer-social-links.css";

const SOCIAL_LINKS = [
  "Discord",
  "Fluxer",
  "Stoat",
  "hey.xyz",
  "Bluesky",
  "Twitter",
  "Mastodon",
  "Email",
] as const;

export function FooterSocialLinks() {
  return (
    <nav className="footer-social-links" aria-label="Social links">
      <ul>
        {SOCIAL_LINKS.map((label) => (
          <li key={label}>
            <a href="https://lovelyowner.com/" target="_blank" rel="noopener noreferrer">
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
