import { FC } from 'react';
import LayersIcon from '@material-ui/icons/Layers';
import { SvgIconProps } from '@material-ui/core';

const PlatformRevisionIcon: FC<SvgIconProps> = (props: SvgIconProps) => {
    return (
        <>
            <LayersIcon {...props} />
        </>
    );
};

export default PlatformRevisionIcon;
