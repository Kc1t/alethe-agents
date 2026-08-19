import { useState } from 'react'

   
                                                                              
                                                                          
                                                                          
                                                               
  
                                                                           
            
   
export function Avatar({
  src,
  initial,
  className,
  alt = '',
}: {
  src: string | null
  initial: string
  className?: string
  alt?: string
}) {
  const [failed, setFailed] = useState(false)
  if (src && !failed) {
    return (
      <img
        src={src}
        alt={alt}
        className={className}
        draggable={false}
        onError={() => setFailed(true)}
      />
    )
  }
  return <span className={className}>{initial}</span>
}
