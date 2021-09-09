import { FC } from 'react';
import { SvgIconProps } from '@material-ui/core';
import CenterFocusWeakIcon from '@material-ui/icons/CenterFocusWeak';

const ActionIcon: FC<SvgIconProps> = (props: SvgIconProps) => {
    return (
        <>
            <CenterFocusWeakIcon {...props} />
        </>
    );
};

export default ActionIcon;
