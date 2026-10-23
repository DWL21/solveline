import { useState } from 'react';

/** Google 프로필 사진. 없거나 못 불러오면 이메일 첫 글자. */
export function Avatar({ picture, email, size = 32 }: { picture: string; email: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (picture && !broken)
    return <img src={picture} alt="" style={style} className="shrink-0 rounded-full" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  return (
    <span style={style} className="flex shrink-0 items-center justify-center rounded-full bg-raised font-bold" aria-hidden>
      {email[0]?.toUpperCase()}
    </span>
  );
}
